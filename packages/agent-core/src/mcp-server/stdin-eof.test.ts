import { describe, expect, test } from 'vitest';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_PATH = path.resolve(__dirname, '__fixtures__', 'stdin-eof-harness.ts');

// stdin-EOF live-path regression test.
//
// Spawns a REAL subprocess that runs runStdioServer() while a keep-alive timer
// holds the event loop open (simulating an active preview's tunnel WS +
// refresh timer). We then end its stdin (EOF) and assert the process exits with
// code 0 on its own — proving runStdioServer wires a stdin-EOF handler that
// tears down and exits.
//
// Guard value: before the fix, runStdioServer relied on transport.onclose,
// which the SDK's StdioServerTransport never fires on stdin EOF (it only
// registers stdin 'data'/'error' listeners). The keep-alive timer would then
// keep this process alive indefinitely and this test would TIME OUT. So this
// test fails if the stdin-EOF wiring is removed or reverted to the no-op.
const runUntilStdinEnd = (): Promise<{ exitCode: number | null; signal: NodeJS.Signals | null; stderr: string }> =>
  new Promise((resolve, reject) => {
    const proc = spawn('npx', ['tsx', HARNESS_PATH], {
      // WORKER_ID is required by readEnvContext; WORKER_RUNTIME is left unset so
      // adoptPreview() short-circuits (no AWS calls needed for this test).
      env: { ...process.env, WORKER_ID: 'stdin-eof-test-worker' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    proc.stderr.on('data', (c) => (stderr += c.toString()));
    proc.on('error', reject);
    proc.on('exit', (code, signal) => resolve({ exitCode: code, signal, stderr }));

    // Let the server connect and install its stdin-EOF listeners, then send EOF.
    setTimeout(() => proc.stdin.end(), 2000);
  });

describe('runStdioServer stdin-EOF shutdown', () => {
  test('exits with code 0 on stdin EOF even while a keep-alive timer holds the event loop', async () => {
    const { exitCode, signal, stderr } = await runUntilStdinEnd();
    // Exited on its own (not killed) with code 0.
    expect(signal).toBeNull();
    expect(exitCode).toBe(0);
    // The harness must not have crashed in runStdioServer.
    expect(stderr).not.toContain('runStdioServer failed');
  }, 30_000);
});
