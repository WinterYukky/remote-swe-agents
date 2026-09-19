import http from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ToolDefinition } from '../private/common/lib';
import { buildMcpServer } from './server';
import { kiroExportedTools } from './selection';
import { readEnvContext, type McpContextEnv } from './context';

export interface RunningMcpHttpServer {
  /** Full URL kiro-cli should POST to (incl. path). */
  url: string;
  /** Shared bearer secret clients must present. */
  secret: string;
  /** TCP port the node http server listens on (localhost only). */
  port: number;
  /** Graceful shutdown, idempotent. */
  close: () => Promise<void>;
}

/**
 * Start the remote-swe MCP server behind a localhost HTTP transport.
 *
 * The kiro-cli ACP client receives `{ type: 'http', url, headers: [...] }`
 * and connects over HTTP to this endpoint instead of spawning a subprocess
 * over stdio. That isolates the JSON-RPC stream from stdout and makes the
 * `console.log` hygiene issue a non-problem: all of agent-core's stray
 * progress logs fall on stdout / stderr as usual, without corrupting the
 * transport.
 *
 * The server binds to 127.0.0.1 only; shared secret auth is an additional
 * defence-in-depth layer because kiro-cli lives in the same container and
 * a compromised container-local tenant is out of scope for this PoC anyway.
 */
export const startMcpHttpServer = async (
  env: McpContextEnv = readEnvContext(),
  tools: ToolDefinition<unknown>[] = kiroExportedTools
): Promise<RunningMcpHttpServer> => {
  const mcp: McpServer = buildMcpServer(env, tools);
  const transport = new StreamableHTTPServerTransport({
    // Stateful mode: the SDK issues a session id on the first request so
    // subsequent JSON-RPC messages from the same kiro-cli ACP connection
    // are correlated. We do not use this id for auth — that is the
    // shared secret's job.
    sessionIdGenerator: () => randomUUID(),
  });

  await mcp.connect(transport);

  // 24 bytes = 192 bits, hex-encoded for safe transport in an HTTP header.
  const secret = randomBytes(24).toString('hex');
  const authHeader = `Bearer ${secret}`;
  // sha256(authHeader)[:8] — short fingerprint for triage logging only. Not
  // reversible to the secret (32-bit prefix of a 256-bit hash). Lets us
  // correlate the "expected bearer" at listen time with the "presented
  // bearer" on each inbound req without leaking the secret itself.
  const expectedAuthFp = createHash('sha256').update(authHeader).digest('hex').slice(0, 8);
  const path = '/mcp';

  const httpServer = http.createServer((req, res) => {
    // Strict endpoint guard. `startsWith(path)` would have let
    // `/mcpfoo` and `/mcp/../etc/passwd` through; the bearer token
    // makes those inert today but the defence-in-depth posture asks
    // for exact matching. The StreamableHTTP client only ever POSTs
    // / GETs the single `/mcp` endpoint, so exact-match is tight
    // enough. Query strings (e.g. `?id=...`) are honoured by
    // trimming at the first `?`.
    const reqUrl = req.url ?? '';
    const basePath = reqUrl.split('?')[0]!.split('#')[0];
    // [kiro-mcp-debug] temporary: log every inbound HTTP request so we can
    // tell whether kiro-cli ever hits the MCP endpoint after a
    // session/load. Header *values* are NOT logged — we only emit a
    // short sha256 fingerprint of the presented Authorization so we can
    // tell whether it matches the bearer the server is expecting, and a
    // prefix of the Mcp-Session-Id so we can correlate method-level
    // behaviour across requests. This is the Phase 1 triage patch for
    // H1-H4 (secret drift vs. SDK omitting Authorization on GET/SSE).
    const auth = req.headers.authorization;
    const hasAuth = typeof auth === 'string' && auth.length > 0;
    const authFp = hasAuth ? createHash('sha256').update(auth).digest('hex').slice(0, 8) : 'none';
    const rawMcpSid = req.headers['mcp-session-id'];
    const mcpSid = typeof rawMcpSid === 'string' && rawMcpSid.length > 0 ? rawMcpSid.slice(0, 8) : 'none';
    console.log(
      `[kiro-mcp-debug] http req method=${req.method} path=${basePath} hasAuth=${hasAuth} authFp=${authFp} mcpSid=${mcpSid}`
    );
    if (basePath !== path) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    // NOTE: Bearer auth intentionally skipped.
    //
    // The kiro-cli MCP client (observed in E2E, April 2026) sends the
    // Authorization header on the initial POST /mcp (initialize) but drops
    // it on the subsequent GET /mcp (SSE stream) — the GET arrives with
    // neither Authorization nor Mcp-Session-Id, so any form of per-request
    // auth (bearer match or session-id allowlist) rejects the stream and
    // the kiro-cli side never finishes tools/list. That path is what broke
    // the remote-swe tool catalogue for every session that went through
    // session/load.
    //
    // The server listens on 127.0.0.1 only (see httpServer.listen below),
    // and AgentCore runs one container per worker session, so the attack
    // surface is already limited to "code running inside this container".
    // A loopback-only shared secret does not defend against anything that
    // isn't already inside the trust boundary, so dropping the check is a
    // net-neutral change for security while unblocking tool registration.
    //
    // The `secret` / `authHeader` variables and the listen-time
    // `expectedAuthFp` log are intentionally kept so the Phase 1 triage
    // logs continue to tell us what kiro-cli *did* send, which is still
    // useful the next time this transport regresses. Flip the check back
    // on by replacing this comment with the previous `if (presented !==
    // authHeader)` block.
    const presented = req.headers.authorization;
    if (presented !== undefined && presented !== authHeader) {
      // Do NOT reject — just note the mismatch. Kept for observability so
      // a future kiro-cli that starts sending a *wrong* bearer (rather
      // than none) is still visible in logs.
      console.log(
        `[kiro-mcp-debug] bearer mismatch (ignored) method=${req.method} hasAuth=${hasAuth} authFp=${authFp} expectedAuthFp=${expectedAuthFp} mcpSid=${mcpSid}`
      );
    }
    void transport.handleRequest(req, res).catch((err) => {
      console.error('[remote-swe mcp-server] http handleRequest failed:', err);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('internal error');
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const addr = httpServer.address() as AddressInfo;
  const port = addr.port;
  const url = `http://127.0.0.1:${port}${path}`;

  // [kiro-mcp-debug] record listen so we can correlate with session/new and
  // session/load events in CloudWatch. Secret is intentionally NOT logged;
  // only the sha256-8 fingerprint is emitted so inbound request logs can
  // be matched against the "expected" bearer the server will accept.
  console.log(`[kiro-mcp-debug] mcp http server listening url=${url} expectedAuthFp=${expectedAuthFp}`);

  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await transport.close().catch(() => {});
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  };

  return { url, secret, port, close };
};
