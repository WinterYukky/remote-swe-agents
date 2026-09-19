import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { randomBytes } from 'node:crypto';
import os from 'os';
import path from 'path';
import { getSecretString } from '@remote-swe-agents/agent-core/aws';
import type { KiroAcpMcpServer } from '@remote-swe-agents/agent-core/lib';

/**
 * Generic secret injection for custom-agent MCP servers.
 *
 * mcpConfig authors can reference secrets stored in AWS Secrets Manager
 * (same account/region as the worker) without ever writing the secret value
 * into the agent definition, DynamoDB, or any on-disk profile JSON:
 *
 *   - `${secret:NAME}`     — replaced with the secret's string value.
 *   - `${secretFile:NAME}` — the secret is materialised to a 0600 file (in a
 *                            0700 per-process directory) and the placeholder is
 *                            replaced with its path. Use this for credentials
 *                            that a server expects as a file (e.g. OAuth token
 *                            JSON, key files).
 *
 * `NAME` maps to the Secrets Manager secret `remote-swe/mcp-secrets/NAME`.
 * The prefix acts as a namespace so IAM can scope the worker to exactly this
 * family of secrets.
 *
 * Placeholders are resolved in the `env` values, `args` entries and `command`
 * of stdio servers — i.e. only in values that are handed to the subprocess at
 * spawn time and never persisted. If any referenced secret cannot be resolved,
 * the whole server is dropped (with a console.error) rather than spawning it
 * with a dangling placeholder; a broken optional integration must not break the
 * session.
 *
 * SECURITY NOTES:
 *   - `command` and `args` are visible in `/proc/<pid>/cmdline` to any process
 *     in the container. Prefer `env` or `${secretFile:...}` for secret VALUES;
 *     an inline `${secret:...}` in `command`/`args` is supported but its
 *     resolved value is exposed on the process command line.
 *   - http/sse servers: a `${secret:...}` / `${secretFile:...}` placeholder in
 *     the `url` is NOT resolved — it would embed a secret value in a URL (broad
 *     exposure: logs, referrers, history) and http custom-agent servers have no
 *     schema-supported header field to carry a bearer secret. A url containing
 *     a placeholder is treated as a dangling placeholder and the server is
 *     dropped, honouring the "never spawn/connect with an unresolved
 *     placeholder" invariant.
 */

export const MCP_SECRET_PREFIX = 'remote-swe/mcp-secrets/';

// Restrictive on purpose: the name is used both as a Secrets Manager name
// suffix and as a tmp file name, so no path separators or expansion chars.
// The lookahead requires at least one alphanumeric character so dot-only /
// separator-only names (".", "..", "-", "_", "._-") — which would resolve to a
// traversal-adjacent or empty file name — are rejected.
const SECRET_NAME_PATTERN = /^(?=.*[a-zA-Z0-9])[a-zA-Z0-9_.-]+$/;

// Global regex used by matchAll (resolveString). matchAll REQUIRES a global
// regex and advances an internal lastIndex during iteration.
const PLACEHOLDER_PATTERN = /\$\{(secret|secretFile):([^}]*)\}/g;
// Separate, NON-global regex for hasPlaceholder. A non-global regex's .test()
// never mutates lastIndex, so this can never poison the global regex used by
// matchAll. (Sharing one /g regex across .test() and .matchAll() is a bug:
// .test() leaves lastIndex mid-string and String.prototype.matchAll copies the
// source regex's lastIndex, silently skipping earlier placeholders in the next
// string it scans — e.g. an http url drop followed by a later stdio server.)
const PLACEHOLDER_TEST_PATTERN = /\$\{(?:secret|secretFile):[^}]*\}/;

/**
 * Per-process random subdirectory for materialised secret files.
 *
 * The directory is randomised ONCE per worker process (not per spawn) on
 * purpose:
 *   - Per-process randomness reduces path predictability versus a fixed
 *     `os.tmpdir()/remote-swe-mcp-secrets` location (defence-in-depth on top of
 *     the 0700 dir / 0600 file perms).
 *   - It is STABLE across turns within the same warm worker, so the resolved
 *     secretFile path is identical turn-to-turn. This matters because the
 *     resolved MCP server list is folded into the kiro-agent-pool reuse key
 *     (see buildReuseKey / kiro-acp-sdk-agent-loop.ts): a path that changed
 *     every spawn would change the reuse key every turn and silently defeat the
 *     turn-to-turn process reuse. (Known asymmetry: because the path is
 *     stable, a rotated secret VALUE is not re-materialised until the pooled
 *     process is recycled — up to KIRO_ACP_PROCESS_MAX_AGE_MS, default 6h.)
 *
 * NOTE ON STORAGE: on AgentCore the container `/tmp` is overlayfs
 * (disk-backed), NOT a tmpfs/RAM mount, so these files touch disk. The 0700
 * directory + 0600 file permissions are the protection, not memory residency.
 */
let cachedSecretFileDir: string | undefined;
const secretFileDir = (): string => {
  if (!cachedSecretFileDir) {
    cachedSecretFileDir = path.join(os.tmpdir(), `remote-swe-mcp-secrets-${randomBytes(8).toString('hex')}`);
  }
  return cachedSecretFileDir;
};

/**
 * Best-effort cleanup of materialised secret files on process exit: the whole
 * per-process directory is removed when the worker exits.
 *
 * We register ONLY a `process.once('exit', ...)` handler and deliberately do
 * NOT trap SIGTERM/SIGINT here. The worker already installs an async graceful
 * shutdown on those signals (see packages/worker/src/common/signal-handler.ts:
 * notify parent → DDB status → disposeAllBackends → MCP/port cleanup →
 * process.exit(0), 10s-bounded). Trapping the signals here and re-raising would
 * clobber that graceful handler and hard-kill the process (exit 143, the 'exit'
 * event never fires). Because signal-handler converts every signal into
 * process.exit(0), the synchronous 'exit' handler below reliably runs on
 * deploy/eviction. (Hard SIGKILL / crash cannot run any JS, so on-disk 0700/0600
 * perms remain the primary protection.)
 */
let cleanupRegistered = false;
const registerCleanup = () => {
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  // 'exit' handlers must be synchronous; rmSync is synchronous.
  process.once('exit', () => {
    if (!cachedSecretFileDir) return;
    try {
      rmSync(cachedSecretFileDir, { recursive: true, force: true });
    } catch {
      // best-effort; ignore
    }
  });
};

const materializeSecretFile = (name: string, value: string): string => {
  const dir = secretFileDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // mkdirSync's mode is ignored when the dir already exists; re-assert it.
  chmodSync(dir, 0o700);
  const filePath = path.join(dir, name);
  writeFileSync(filePath, value, { mode: 0o600 });
  chmodSync(filePath, 0o600);
  registerCleanup();
  return filePath;
};

const hasPlaceholder = (input: string): boolean => PLACEHOLDER_TEST_PATTERN.test(input);

const resolveString = async (
  input: string,
  fetchSecret: (secretId: string) => Promise<string>,
  cache: Map<string, Promise<string>>
): Promise<string> => {
  const matches = [...input.matchAll(PLACEHOLDER_PATTERN)];
  if (matches.length === 0) return input;
  let result = input;
  for (const match of matches) {
    const placeholder = match[0];
    const kind = match[1]!;
    const name = match[2] ?? '';
    if (!SECRET_NAME_PATTERN.test(name)) {
      throw new Error(`invalid secret name "${name}" in placeholder ${placeholder}`);
    }
    const secretId = `${MCP_SECRET_PREFIX}${name}`;
    let pending = cache.get(secretId);
    if (!pending) {
      pending = fetchSecret(secretId);
      cache.set(secretId, pending);
    }
    const value = await pending;
    const replacement = kind === 'secretFile' ? materializeSecretFile(name, value) : value;
    result = result.split(placeholder).join(replacement);
  }
  return result;
};

/**
 * Resolve secret placeholders across a list of ACP MCP server descriptors.
 * Servers whose placeholders all resolve are returned (with substituted
 * values); servers with any unresolvable / dangling placeholder are dropped.
 */
export const resolveMcpServerSecrets = async (
  servers: KiroAcpMcpServer[],
  fetchSecret: (secretId: string) => Promise<string> = getSecretString
): Promise<KiroAcpMcpServer[]> => {
  const cache = new Map<string, Promise<string>>();
  const resolved: KiroAcpMcpServer[] = [];
  for (const server of servers) {
    try {
      if (server.type === 'stdio') {
        resolved.push({
          ...server,
          command: await resolveString(server.command, fetchSecret, cache),
          args: await Promise.all(server.args.map((a) => resolveString(a, fetchSecret, cache))),
          env: await Promise.all(
            server.env.map(async (e) => ({ name: e.name, value: await resolveString(e.value, fetchSecret, cache) }))
          ),
        });
      } else {
        // http/sse: never inject a secret into the url (broad exposure) and
        // there is no schema-supported secret-carrying field. A placeholder in
        // the url is a dangling placeholder → drop the server rather than
        // connect with it unresolved.
        if (hasPlaceholder(server.url)) {
          throw new Error(
            `secret placeholder is not supported in the url of an ${server.type} server; use env/secretFile on a stdio server instead`
          );
        }
        // Defence-in-depth: today parseCustomAgentMcpConfig always emits an
        // empty headers array (the mcpConfig url schema has no headers field),
        // so this loop is a no-op for the current caller. It is kept so a
        // FUTURE caller that supplies header values gets placeholders resolved
        // (and a dangling placeholder drops the server) instead of spreading an
        // unresolved `${secret:...}` header value straight through.
        resolved.push({
          ...server,
          headers: await Promise.all(
            server.headers.map(async (h) => ({ name: h.name, value: await resolveString(h.value, fetchSecret, cache) }))
          ),
        });
      }
    } catch (e) {
      console.error(`[kiro-mcp-secrets] dropping MCP server "${server.name}": failed to resolve secrets:`, e);
    }
  }
  return resolved;
};

export const __internal = { resolveString, materializeSecretFile, secretFileDir, hasPlaceholder };
