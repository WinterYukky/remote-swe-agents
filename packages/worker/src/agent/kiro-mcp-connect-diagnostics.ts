import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * KAS (kiro-cli) records MCP connection outcomes to a per-invocation log at
 * `~/.kiro/logs/<timestamp>/mcp.log` — NOT to stdout/stderr — so a server whose
 * connect exceeds KAS's deadline is dropped SILENTLY from the model's toolset
 * (`mcp.connect.error` → `actualStatus:"removed"`, error suppressed). This
 * module lifts that hidden signal into the worker's own logs so we can observe,
 * per server and per turn:
 *   - whether the server connected (ok) or was removed (error/removed),
 *   - how long the connect took (`connectDurationMs`) — the quantity that races
 *     KAS's connect deadline and causes the MCP tool-flake.
 *
 * The mcp.log line schema (single-line JSON objects), observed empirically:
 *   success: {message:"Connected with transport", transportType, connectDurationMs, serverName}
 *            {message:"mcp.connect.ok", serverName}
 *   failure: {message:"mcp.connect.error", serverName}
 *            {message:"Connection failed but server was removed or changed status,
 *                      suppressing error", actualStatus:"removed", serverName}
 *
 * All parsing is best-effort and tolerant: the format is KAS-internal and may
 * change, so a parse miss degrades to "unknown" rather than throwing into the
 * agent loop.
 */

export type McpConnectStatus = 'ok' | 'error' | 'removed' | 'unknown';

export interface McpServerConnectSummary {
  serverName: string;
  status: McpConnectStatus;
  connectDurationMs?: number;
  transportType?: string;
}

interface McpLogLine {
  message?: string;
  serverName?: string;
  connectDurationMs?: number;
  transportType?: string;
  actualStatus?: string;
}

/**
 * Resolve the base directory KAS writes its per-invocation logs to. KAS uses
 * its process homedir (`~/.kiro/logs`), and the worker spawns kiro-cli/KAS with
 * `HOME = process.env.HOME ?? '/root'` (see kiro-acp-transport.ts). We therefore
 * resolve the base from `process.env.HOME` FIRST so the diagnostic reads exactly
 * where the KAS subprocess writes, falling back to os.homedir() only when HOME
 * is unset. (The earlier os.homedir()-only form could diverge from the HOME the
 * worker hands KAS, making the diagnostic look at the wrong directory.)
 */
const kiroLogsDir = (): string => path.join(process.env.HOME || os.homedir(), '.kiro', 'logs');

/**
 * How many of the most-recent `~/.kiro/logs/<ts>/mcp.log` files to consider.
 *
 * Root cause: KAS creates a NEW `~/.kiro/logs/<ts>/` directory on
 * every kiro-cli spawn, and the worker spawns a fresh kiro-cli per turn. The
 * "newest mtime dir" the diagnostic used to read is frequently a just-created
 * run dir whose mcp.log has no connect lines yet (or belongs to a different
 * spawn than the one that connected), so a real, parseable connect log in a
 * slightly-older sibling dir was missed and the diagnostic reported "no
 * parseable entries". We therefore scan the most recent N dirs, not just one.
 */
const MAX_MCP_LOG_DIRS_SCANNED = 8;

/**
 * Return the paths of the most recent `~/.kiro/logs/<ts>/mcp.log` files
 * (newest first, up to {@link MAX_MCP_LOG_DIRS_SCANNED}). Directories are named
 * with a sortable timestamp prefix, but we sort by mtime to be robust to any
 * naming change.
 */
const findRecentMcpLogs = (logsDir = kiroLogsDir()): string[] => {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(logsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const candidates: { file: string; mtimeMs: number }[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(logsDir, e.name, 'mcp.log');
    try {
      const st = fs.statSync(file);
      candidates.push({ file, mtimeMs: st.mtimeMs });
    } catch {
      // no mcp.log in this dir; skip
    }
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return candidates.slice(0, MAX_MCP_LOG_DIRS_SCANNED).map((c) => c.file);
};

/**
 * Return the newest `~/.kiro/logs/<ts>/mcp.log` path, or undefined if none.
 * Retained for compatibility; prefer {@link findRecentMcpLogs}.
 */
const findLatestMcpLog = (logsDir = kiroLogsDir()): string | undefined => findRecentMcpLogs(logsDir)[0];

/**
 * Parse mcp.log content into a per-server connect summary. Exported for tests.
 *
 * Later lines win for a given server (a server may log error then a retry ok).
 * We fold each server to its most decisive terminal state, preferring an
 * explicit ok/removed/error over "unknown", and capture connectDurationMs from
 * whichever line carried it.
 */
export const parseMcpLog = (content: string): McpServerConnectSummary[] => {
  const byServer = new Map<string, McpServerConnectSummary>();

  const upsert = (name: string): McpServerConnectSummary => {
    let cur = byServer.get(name);
    if (!cur) {
      cur = { serverName: name, status: 'unknown' };
      byServer.set(name, cur);
    }
    return cur;
  };

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    let obj: McpLogLine;
    try {
      obj = JSON.parse(line) as McpLogLine;
    } catch {
      continue;
    }
    const name = obj.serverName;
    if (!name) continue;
    const entry = upsert(name);

    if (typeof obj.connectDurationMs === 'number') {
      entry.connectDurationMs = obj.connectDurationMs;
    }
    if (typeof obj.transportType === 'string') {
      entry.transportType = obj.transportType;
    }

    const msg = obj.message ?? '';
    if (msg === 'mcp.connect.ok') {
      entry.status = 'ok';
    } else if (obj.actualStatus === 'removed' || msg.includes('was removed or changed status')) {
      entry.status = 'removed';
    } else if (msg === 'mcp.connect.error') {
      // Only downgrade to 'error' if we have not already seen ok/removed for it.
      if (entry.status === 'unknown') entry.status = 'error';
    } else if (msg === 'Connected with transport' && entry.status === 'unknown') {
      // Transport connected; a following mcp.connect.ok usually confirms. Leave
      // as unknown until we see the explicit ok, but keep the duration.
    }
  }

  return [...byServer.values()];
};

/**
 * Cap on how much of an mcp.log we read synchronously. The file grows across a
 * worker's lifetime; a multi-MB read blocks the event loop (Reviewer measured
 * ~234ms sync block on a 17MB file). The connect outcomes we care about are the
 * most recent lines, so when the file exceeds the cap we read only the trailing
 * MAX_MCP_LOG_BYTES.
 */
const MAX_MCP_LOG_BYTES = 2 * 1024 * 1024;

/** Read up to the trailing `maxBytes` of a file as utf8, without loading it whole. */
const readFileTail = (file: string, size: number, maxBytes: number): string => {
  if (size <= maxBytes) {
    return fs.readFileSync(file, 'utf8');
  }
  const fd = fs.openSync(file, 'r');
  try {
    const start = size - maxBytes;
    const buf = Buffer.allocUnsafe(maxBytes);
    const read = fs.readSync(fd, buf, 0, maxBytes, start);
    // Drop the first (likely partial) line so we never mis-parse a truncated head.
    const text = buf.subarray(0, read).toString('utf8');
    const nl = text.indexOf('\n');
    return nl >= 0 ? text.slice(nl + 1) : text;
  } finally {
    fs.closeSync(fd);
  }
};

export interface McpConnectReadResult {
  /** true when a latest mcp.log file was found and read (even if it had no parseable lines). */
  found: boolean;
  summary: McpServerConnectSummary[];
}

/**
 * Read the most recent KAS mcp.log(s) and return a per-server connect summary
 * plus whether any log file was found.
 *
 * log-directory rotation: a single newest-mtime dir is unreliable because KAS makes a fresh
 * run dir per kiro-cli spawn and the newest one is often empty at read time. We
 * scan the most recent {@link MAX_MCP_LOG_DIRS_SCANNED} dirs (newest first) and
 * return the FIRST one that yields a non-empty parse (i.e. has real connect
 * outcomes). If none has parseable entries we still report `found:true` (a log
 * existed) with an empty summary, distinguishing "present but empty" from "no
 * log at all". Best-effort; large logs are tail-read (see MAX_MCP_LOG_BYTES).
 */
export const readLatestMcpConnectResult = (logsDir = kiroLogsDir()): McpConnectReadResult => {
  const files = findRecentMcpLogs(logsDir);
  if (files.length === 0) return { found: false, summary: [] };
  let foundAny = false;
  for (const file of files) {
    let content: string;
    try {
      const st = fs.statSync(file);
      content = readFileTail(file, st.size, MAX_MCP_LOG_BYTES);
    } catch {
      continue;
    }
    foundAny = true;
    const summary = parseMcpLog(content);
    if (summary.length > 0) return { found: true, summary };
  }
  return { found: foundAny, summary: [] };
};

/**
 * Read the latest KAS mcp.log and return a per-server connect summary.
 * Best-effort: returns an empty array if the log is missing or unparseable.
 */
export const readLatestMcpConnectSummary = (logsDir = kiroLogsDir()): McpServerConnectSummary[] =>
  readLatestMcpConnectResult(logsDir).summary;

/**
 * Read the latest KAS mcp.log and emit a single structured diagnostic line to
 * the worker log so CloudWatch (and the E2E prober) can see per-server connect
 * outcomes and durations. Never throws.
 *
 * @param context short label (e.g. workerId or turn tag) for correlation.
 */
export const logMcpConnectDiagnostics = (context: string, logsDir = kiroLogsDir()): void => {
  try {
    const { found, summary } = readLatestMcpConnectResult(logsDir);
    if (summary.length === 0) {
      const reason = found ? 'no parseable mcp.log entries' : 'no mcp.log found';
      console.log(`[kiro-mcp-connect] context=${context} ${reason} (nothing to report)`);
      return;
    }
    const anyRemovedOrError = summary.some((s) => s.status === 'removed' || s.status === 'error');
    const payload = summary.map((s) => ({
      name: s.serverName,
      status: s.status,
      connectDurationMs: s.connectDurationMs,
      transportType: s.transportType,
    }));
    const level = anyRemovedOrError ? console.warn : console.log;
    level(`[kiro-mcp-connect] context=${context} anyFailure=${anyRemovedOrError} servers=${JSON.stringify(payload)}`);
  } catch (e) {
    console.warn('[kiro-mcp-connect] failed to read/parse mcp.log:', e);
  }
};

// Re-export internals for unit tests.
export const __internal = {
  findLatestMcpLog,
  findRecentMcpLogs,
  kiroLogsDir,
  MAX_MCP_LOG_DIRS_SCANNED,
};
