import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseMcpLog,
  readLatestMcpConnectSummary,
  readLatestMcpConnectResult,
  logMcpConnectDiagnostics,
} from './kiro-mcp-connect-diagnostics';

// Real KAS mcp.log lines captured empirically (kiro-cli acp v3, stdio remote-swe).
const OK_LINES = [
  JSON.stringify({
    timestamp: '2026-08-24T08:45:21.639Z',
    level: 'info',
    message: 'Connected with transport',
    transportType: 'stdio',
    connectDurationMs: 2504,
    serverName: 'remote-swe',
  }),
  JSON.stringify({
    timestamp: '2026-08-24T08:45:21.639Z',
    level: 'info',
    message: 'mcp.connect.ok',
    serverName: 'remote-swe',
  }),
  JSON.stringify({
    timestamp: '2026-08-24T08:45:21.656Z',
    level: 'info',
    message: 'Connected',
    serverName: 'remote-swe',
  }),
].join('\n');

const REMOVED_LINES = [
  JSON.stringify({
    timestamp: '2026-08-24T08:45:00.421Z',
    level: 'warn',
    message: 'mcp.connect.error',
    serverName: 'remote-swe',
  }),
  JSON.stringify({
    timestamp: '2026-08-24T08:45:00.421Z',
    level: 'info',
    message: 'Connection failed but server was removed or changed status, suppressing error',
    actualStatus: 'removed',
    serverName: 'remote-swe',
  }),
  JSON.stringify({
    timestamp: '2026-08-24T08:45:00.422Z',
    level: 'info',
    message: 'Connection closed successfully',
    serverName: 'remote-swe',
  }),
].join('\n');

describe('parseMcpLog', () => {
  test('parses a successful stdio connect with connectDurationMs', () => {
    const [s, ...rest] = parseMcpLog(OK_LINES);
    expect(rest).toEqual([]);
    expect(s).toEqual({
      serverName: 'remote-swe',
      status: 'ok',
      connectDurationMs: 2504,
      transportType: 'stdio',
    });
  });

  test('parses the silent-removal failure (silent-removal signature) as status=removed', () => {
    const [s] = parseMcpLog(REMOVED_LINES);
    expect(s!.serverName).toBe('remote-swe');
    // The whole point of the diagnostic: this MUST surface as a failure even
    // though KAS suppressed the error.
    expect(s!.status).toBe('removed');
  });

  test('folds multiple servers independently (partial-connection variant)', () => {
    const mixed = [
      JSON.stringify({
        message: 'Connected with transport',
        transportType: 'stdio',
        connectDurationMs: 120,
        serverName: 'playwright',
      }),
      JSON.stringify({ message: 'mcp.connect.ok', serverName: 'playwright' }),
      JSON.stringify({
        message: 'Connected with transport',
        transportType: 'stdio',
        connectDurationMs: 95,
        serverName: 'fetch',
      }),
      JSON.stringify({ message: 'mcp.connect.ok', serverName: 'fetch' }),
      JSON.stringify({ message: 'mcp.connect.error', serverName: 'remote-swe' }),
      JSON.stringify({
        message: 'Connection failed but server was removed or changed status, suppressing error',
        actualStatus: 'removed',
        serverName: 'remote-swe',
      }),
    ].join('\n');
    const byName = Object.fromEntries(parseMcpLog(mixed).map((s) => [s.serverName, s]));
    expect(byName['playwright']!.status).toBe('ok');
    expect(byName['fetch']!.status).toBe('ok');
    expect(byName['remote-swe']!.status).toBe('removed');
  });

  test('ignores blank and non-JSON lines without throwing', () => {
    const noisy = ['', '   ', 'not json at all', OK_LINES].join('\n');
    const res = parseMcpLog(noisy);
    expect(res).toHaveLength(1);
    expect(res[0]!.status).toBe('ok');
  });

  test('lines without a serverName are skipped', () => {
    const res = parseMcpLog(JSON.stringify({ message: 'mcp.connect.ok' }));
    expect(res).toEqual([]);
  });
});

describe('readLatestMcpConnectSummary + logMcpConnectDiagnostics (real fs)', () => {
  let tmpLogsDir: string;
  beforeEach(() => {
    tmpLogsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kiro-logs-'));
  });
  afterEach(() => {
    fs.rmSync(tmpLogsDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const writeLog = (subdir: string, content: string) => {
    const dir = path.join(tmpLogsDir, subdir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'mcp.log'), content);
  };

  test('reads the newest mcp.log by mtime', () => {
    writeLog('20260824T000000000', REMOVED_LINES);
    // Ensure the second dir is strictly newer.
    const newer = path.join(tmpLogsDir, '20260824T111111111');
    fs.mkdirSync(newer, { recursive: true });
    fs.writeFileSync(path.join(newer, 'mcp.log'), OK_LINES);
    const future = Date.now() + 5000;
    fs.utimesSync(path.join(newer, 'mcp.log'), future / 1000, future / 1000);

    const summary = readLatestMcpConnectSummary(tmpLogsDir);
    expect(summary).toHaveLength(1);
    expect(summary[0]!.status).toBe('ok');
    expect(summary[0]!.connectDurationMs).toBe(2504);
  });

  test('returns [] when no mcp.log exists', () => {
    expect(readLatestMcpConnectSummary(path.join(tmpLogsDir, 'nope'))).toEqual([]);
  });

  test('log-directory rotation: scans older sibling run-dirs when the NEWEST dir has no parseable connect lines', () => {
    // Root cause: KAS makes a fresh ~/.kiro/logs/<ts>/ per kiro-cli spawn, so
    // the newest-mtime dir is often a just-created run whose mcp.log has no
    // connect outcome yet, while the real connect log lives in a slightly-older
    // sibling. The old single-newest read reported "no parseable entries"; the
    // fix must find the real outcome in the older dir.
    const older = path.join(tmpLogsDir, '20260824T000000000');
    fs.mkdirSync(older, { recursive: true });
    fs.writeFileSync(path.join(older, 'mcp.log'), OK_LINES);
    const past = Date.now() - 5000;
    fs.utimesSync(path.join(older, 'mcp.log'), past / 1000, past / 1000);

    // Newest dir exists but its log has NO parseable connect line (e.g. just
    // "session starting" noise before any server connected).
    const newest = path.join(tmpLogsDir, '20260824T999999999');
    fs.mkdirSync(newest, { recursive: true });
    fs.writeFileSync(path.join(newest, 'mcp.log'), 'not json\n{"message":"session.start"}\n');
    const future = Date.now() + 5000;
    fs.utimesSync(path.join(newest, 'mcp.log'), future / 1000, future / 1000);

    const res = readLatestMcpConnectResult(tmpLogsDir);
    expect(res.found).toBe(true);
    expect(res.summary).toHaveLength(1);
    expect(res.summary[0]!.serverName).toBe('remote-swe');
    expect(res.summary[0]!.status).toBe('ok');
    expect(res.summary[0]!.connectDurationMs).toBe(2504);
  });

  test('readLatestMcpConnectResult distinguishes missing vs present-but-unparseable', () => {
    // missing dir -> found:false
    expect(readLatestMcpConnectResult(path.join(tmpLogsDir, 'nope'))).toEqual({ found: false, summary: [] });
    // present file with no parseable lines -> found:true, empty summary
    writeLog('20260824T000000000', 'garbage\nnot json\n{no server here}');
    const res = readLatestMcpConnectResult(tmpLogsDir);
    expect(res.found).toBe(true);
    expect(res.summary).toEqual([]);
  });

  test('logMcpConnectDiagnostics reports "no parseable mcp.log entries" when file exists but unparseable', () => {
    writeLog('20260824T000000000', 'garbage\nnot json at all');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    logMcpConnectDiagnostics('workerId=w1', tmpLogsDir);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain('no parseable mcp.log entries');
  });

  test('logMcpConnectDiagnostics reports "no mcp.log found" when the dir has no log', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    logMcpConnectDiagnostics('workerId=w1', path.join(tmpLogsDir, 'missing'));
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain('no mcp.log found');
  });

  test('tail-reads a large mcp.log (size cap) and still parses the latest outcome', () => {
    // Prepend ~3MB of noise so the file exceeds the 2MB cap; the real outcome
    // lines are at the tail and must still be parsed.
    const filler = ('x'.repeat(200) + '\n').repeat(15000); // ~3MB
    writeLog('20260824T000000000', filler + OK_LINES);
    const summary = readLatestMcpConnectSummary(tmpLogsDir);
    expect(summary).toHaveLength(1);
    expect(summary[0]!.status).toBe('ok');
    expect(summary[0]!.connectDurationMs).toBe(2504);
  });

  test('logMcpConnectDiagnostics warns when a server was removed/errored', () => {
    writeLog('20260824T000000000', REMOVED_LINES);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logMcpConnectDiagnostics('workerId=w1', tmpLogsDir);
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]![0]);
    expect(msg).toContain('[kiro-mcp-connect]');
    expect(msg).toContain('anyFailure=true');
    expect(msg).toContain('remote-swe');
  });

  test('logMcpConnectDiagnostics logs (not warns) when all servers ok', () => {
    writeLog('20260824T000000000', OK_LINES);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logMcpConnectDiagnostics('workerId=w1', tmpLogsDir);
    expect(warn).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0]![0])).toContain('anyFailure=false');
  });

  test('never throws on unreadable logs dir (best-effort)', () => {
    expect(() => logMcpConnectDiagnostics('ctx', path.join(tmpLogsDir, 'missing'))).not.toThrow();
  });
});
