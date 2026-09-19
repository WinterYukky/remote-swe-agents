/**
 * kiro-acp-transport
 * ===================
 * Spawns a `kiro-cli acp` subprocess and exposes its stdio as the two Web
 * streams the official ACP SDK's `ndJsonStream()` consumes. This is the
 * transport half of the KiroAcpAgent (Strands migration, DESIGN.md
 * design): the official `@agentclientprotocol/sdk` owns the JSON-RPC wire,
 * this file only bridges a Node child process to Web streams.
 *
 * This is the live kiro ACP transport (consumed by `KiroAcpAgent` via the
 * `kiro-acp-sdk-agent-loop`). It replaced the former hand-written ACP client.
 */
import { spawn, type ChildProcess } from 'child_process';
import { existsSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';

export interface KiroAcpProcessOptions {
  cwd?: string;
  model?: string;
  agentName?: string;
  trustAllTools?: boolean;
  apiKey?: string;
  /**
   * Names of the MCP servers being handed to this kiro-cli session. Used to
   * populate `ASBX_KIRO_MANDATORY_MCPS` so KAS unconditionally exposes their
   * tools to the model (the MCP-exposure fix — see spawn env below). Derived from the actual
   * mcpServers list, never hardcoded, so custom-agent servers are covered too.
   */
  mcpServerNames?: string[];
}

export interface KiroAcpProcessHandle {
  /** Web ReadableStream of the subprocess stdout (raw bytes). */
  readable: ReadableStream<Uint8Array>;
  /** Web WritableStream to the subprocess stdin (raw bytes). */
  writable: WritableStream<Uint8Array>;
  /** Underlying child process (for pid / kill / exit wiring). */
  proc: ChildProcess;
  /** Resolves with the exit code/signal once the subprocess exits. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  kill: (signal?: NodeJS.Signals) => void;
}

/**
 * Build the CLI arguments for kiro-cli acp based on options.
 * Exported for spawn-args assertion tests.
 */
export function buildKiroAcpArgs(options: KiroAcpProcessOptions = {}): string[] {
  const args = ['acp', '--agent-engine', 'v3'];
  return args;
}

/**
 * Compute the `ASBX_KIRO_MANDATORY_MCPS` value for a kiro-cli session: the
 * union of any inherited env value and the session's own MCP server names,
 * de-duplicated and trimmed. Returns undefined when the union is empty (so the
 * caller omits the env var entirely rather than setting it blank). Exported and
 * pure so the exposure-gate fix (always-deployed profile) is unit-testable without spawning.
 */
export function computeMandatoryMcpsEnv(
  mcpServerNames: string[] | undefined,
  inherited: string | undefined
): string | undefined {
  const merged = Array.from(
    new Set([
      ...(inherited ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
      ...(mcpServerNames ?? []).map((s) => s.trim()).filter(Boolean),
    ])
  );
  return merged.length > 0 ? merged.join(',') : undefined;
}

/**
 * Spawn `kiro-cli acp` and return Web streams wired to its stdio.
 */
export function spawnKiroAcpProcess(options: KiroAcpProcessOptions = {}): KiroAcpProcessHandle {
  const apiKey = options.apiKey ?? process.env.KIRO_API_KEY;
  if (!apiKey) {
    throw new Error('KIRO_API_KEY is required (set env var or pass options.apiKey).');
  }

  const args = buildKiroAcpArgs(options);

  const home = process.env.HOME ?? '/root';
  const kiroCliPath = `${home}/.local/bin/kiro-cli`;
  const effectiveCwd = options.cwd && existsSync(options.cwd) ? options.cwd : home || '/tmp';

  // the MCP-exposure fix fix: KAS only exposes an MCP server's tools to the model when the
  // session's tool policy opts in (`includeMcpJson`, default false), an
  // `allowedTools` pattern matches, OR the server is listed in
  // `ASBX_KIRO_MANDATORY_MCPS`. The worker creates a default (no-custom-agent)
  // session with none of those, so connected MCP servers' tools were filtered
  // out entirely (servers show `mcp.connect.ok` yet zero MCP tools reach the
  // model). We set ASBX_KIRO_MANDATORY_MCPS to the exact server names we hand
  // this session so KAS unconditionally unions their tools in. This env is
  // exposure-only in KAS (verified: `mandatoryMcpServers` is referenced solely
  // by filterToolsWithFlags + the tool-search never-defer filter, never by the
  // connect/retry/failure path), so a flaky connect never becomes session-fatal
  // because of it. Merged with any inherited value so we never clobber an
  // operator-provided list. See docs/strands-integration-backlog.md (MCP gate).
  const mandatoryMcps = computeMandatoryMcpsEnv(options.mcpServerNames, process.env.ASBX_KIRO_MANDATORY_MCPS);

  const proc = spawn(kiroCliPath, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    cwd: effectiveCwd,
    env: {
      ...process.env,
      KIRO_API_KEY: apiKey,
      PATH: `${home}/.local/bin:${process.env.PATH}`,
      ...(mandatoryMcps !== undefined ? { ASBX_KIRO_MANDATORY_MCPS: mandatoryMcps } : {}),
    },
  });

  proc.stderr!.on('data', (d: Buffer) => {
    const text = d.toString().trim();
    if (text) console.error(`[kiro-acp stderr] ${text.slice(0, 500)}`);
  });

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    proc.once('exit', (code, signal) => {
      console.error(`[kiro-acp] subprocess exited code=${code} signal=${signal}`);
      resolve({ code, signal });
    });
  });

  const readable = Readable.toWeb(proc.stdout!) as ReadableStream<Uint8Array>;
  const writable = Writable.toWeb(proc.stdin!) as WritableStream<Uint8Array>;

  return {
    readable,
    writable,
    proc,
    exited,
    kill: (signal: NodeJS.Signals = 'SIGTERM') => {
      try {
        proc.kill(signal);
      } catch {
        // already dead
      }
    },
  };
}
