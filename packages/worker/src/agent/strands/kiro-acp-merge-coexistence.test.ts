/**
 * #325 ↔ ACP-resilience (e2c97555) MERGE COEXISTENCE — live setup-path integration.
 *
 * This is the live-path test for the merge conflict resolution in
 * `KiroAcpAgent.ensureStarted()`'s connect callback, where TWO lanes' changes
 * meet on the SAME lines:
 *   - main (ACP resilience): the session/new + session/load ACP calls are wrapped
 *     in `withTimeout(..., kiroSessionNewTimeoutMs()/kiroSessionLoadTimeoutMs())`.
 *   - #325 (MCP exposure): the SAME calls carry `_meta.kiro.modeId = agentName`
 *     (from `buildKiroSessionMeta`) so KAS selects the profile that exposes MCP
 *     tools (includeMcpJson=true).
 *
 * A helper-only test (buildKiroSessionMeta returns the right object, withTimeout
 * bounds a promise) passes even if the merge dropped one lane's change from the
 * live call site. This test drives the REAL `ensureStarted()` connect callback
 * (mocking only the two true externals — the subprocess spawn and the ACP client
 * transport) and asserts BOTH lanes are present in the ACTUAL payload handed to
 * KAS, on BOTH the session/new and session/load paths.
 *
 * Litmus — "if I delete the production wiring (not the helper), does a test
 * go red?":
 *   - drop `_meta` from buildSession/request  → modeId assertions fail (below).
 *   - drop `withTimeout` from either call site → the timeout-bound assertions
 *     fail (the never-resolving ACP op would hang past the stubbed short bound
 *     instead of rejecting with the labelled withTimeout error).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---- mock the two true externals -------------------------------------------
// 1) subprocess spawn: no real kiro-cli.
vi.mock('./kiro-acp-transport', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./kiro-acp-transport')>();
  return {
    ...actual,
    spawnKiroAcpProcess: vi.fn(() => ({
      // ndJsonStream only needs these to exist; the mocked client below never
      // actually reads/writes them because we intercept connectWith.
      writable: { getWriter: () => ({ write: async () => {}, close: async () => {}, releaseLock: () => {} }) },
      readable: { getReader: () => ({ read: async () => ({ done: true, value: undefined }), releaseLock: () => {} }) },
      pid: 4242,
      dispose: () => {},
    })),
  };
});

// 2) ACP client: intercept connectWith so it invokes the REAL setup callback
//    from ensureStarted() with a fake ctx that records the buildSession /
//    request payloads. The `app` builder methods are chainable no-ops.
type CapturedCtx = {
  buildSession: ReturnType<typeof vi.fn>;
  request: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
};
let captured: {
  buildSessionArgs: unknown[];
  loadRequests: { method: string; params: any }[];
} = { buildSessionArgs: [], loadRequests: [] };

vi.mock('@agentclientprotocol/sdk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agentclientprotocol/sdk')>();
  return {
    ...actual,
    ndJsonStream: vi.fn(() => ({}) as never),
    client: vi.fn(() => {
      const app: any = {
        onRequest: () => app,
        onNotification: () => app,
        connectWith: (_stream: unknown, cb: (ctx: CapturedCtx) => Promise<void>) => {
          const ctx: CapturedCtx = {
            // session/new path: buildSession(...).start() must resolve (else the
            // withTimeout wrapper would just await a resolved promise).
            buildSession: vi.fn((args: unknown) => {
              captured.buildSessionArgs.push(args);
              return { start: vi.fn(async () => ({ sessionId: 'live-new' })) };
            }),
            // session/load path goes through ctx.request('session/load', {...}).
            request: vi.fn(async (method: string, params: any) => {
              captured.loadRequests.push({ method, params });
              return {};
            }),
            notify: vi.fn(async () => {}),
          };
          // Kick the real setup callback (fire-and-forget, like connectWith).
          return cb(ctx);
        },
      };
      return app;
    }),
  };
});

import { KiroAcpAgent } from './kiro-acp-agent';

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};

describe('#325↔resilience merge: modeId (_meta) AND withTimeout coexist on the live setup path', () => {
  beforeEach(() => {
    captured = { buildSessionArgs: [], loadRequests: [] };
    // Generous inner bounds so a RESOLVED op never trips the timeout during the
    // happy-path coexistence assertions.
    vi.stubEnv('KIRO_ACP_SESSION_NEW_TIMEOUT_MS', '10000');
    vi.stubEnv('KIRO_ACP_SESSION_LOAD_TIMEOUT_MS', '10000');
    vi.stubEnv('KIRO_ACP_INITIALIZE_TIMEOUT_MS', '10000');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('session/new: buildSession receives _meta.kiro.modeId = agentName (MCP exposure lane preserved)', async () => {
    const agent = new KiroAcpAgent({
      cwd: '/tmp/ws',
      agentName: 'remote-swe-worker',
      mcpServers: [{ name: 'remote-swe' } as never],
      // no sessionId => session/new path
    });
    // start() resolves once ensureStarted() completes the setup callback.
    await agent.start();
    await flush();

    expect(captured.buildSessionArgs.length).toBe(1);
    const arg = captured.buildSessionArgs[0] as { _meta?: { kiro?: { modeId?: string } }; cwd?: string };
    expect(arg._meta).toEqual({ kiro: { modeId: 'remote-swe-worker' } });
    // session/load must NOT have been used on the new path.
    expect(captured.loadRequests.filter((r) => r.method === 'session/load')).toHaveLength(0);
  });

  it('session/load (resume): request("session/load") carries _meta.kiro.modeId (MCP exposure lane preserved on resume)', async () => {
    const agent = new KiroAcpAgent({
      cwd: '/tmp/ws',
      agentName: 'remote-swe-worker',
      mcpServers: [{ name: 'remote-swe' } as never],
      sessionId: 'resume-42', // => session/load path
    });
    await agent.start();
    await flush();

    const loads = captured.loadRequests.filter((r) => r.method === 'session/load');
    expect(loads).toHaveLength(1);
    const load = loads[0]!;
    expect(load.params._meta).toEqual({ kiro: { modeId: 'remote-swe-worker' } });
    expect(load.params.sessionId).toBe('resume-42');
  });

  it('the real-.kiro safeguard safe fallback: no agentName => NO _meta sent on either path (degrades to default vibe session)', async () => {
    const agent = new KiroAcpAgent({
      cwd: '/tmp/ws',
      mcpServers: [{ name: 'remote-swe' } as never],
      // agentName undefined => buildKiroSessionMeta returns undefined
    });
    await agent.start();
    await flush();

    expect(captured.buildSessionArgs.length).toBe(1);
    const arg = captured.buildSessionArgs[0] as { _meta?: unknown };
    expect(arg._meta).toBeUndefined();
  });

  it('resilience lane preserved: a never-resolving session/new is bounded by withTimeout (not an unbounded hang)', async () => {
    // Make buildSession().start() hang forever = the real setup-stall failure
    // mode. If the merge had dropped `withTimeout` from the session/new call
    // site, ensureStarted() would hang past the bound; with it, it rejects with
    // the labelled, retryable withTimeout error.
    vi.stubEnv('KIRO_ACP_SESSION_NEW_TIMEOUT_MS', '30');
    const { client } = await import('@agentclientprotocol/sdk');
    (client as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const app: any = {
        onRequest: () => app,
        onNotification: () => app,
        connectWith: (_s: unknown, cb: (ctx: CapturedCtx) => Promise<void>) => {
          const ctx: CapturedCtx = {
            buildSession: vi.fn(() => ({ start: vi.fn(() => new Promise(() => {})) })), // never resolves
            request: vi.fn(async () => ({})),
            notify: vi.fn(async () => {}),
          };
          return cb(ctx);
        },
      };
      return app;
    });

    const agent = new KiroAcpAgent({
      cwd: '/tmp/ws',
      agentName: 'remote-swe-worker',
      mcpServers: [{ name: 'remote-swe' } as never],
    });
    await expect(agent.start()).rejects.toThrow(/session\/new .*timed out|timed out/i);
  }, 15_000);
});
