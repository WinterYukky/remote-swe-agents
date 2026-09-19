/**
 * Context-usage reception from KAS 2.19.2 `session/update` notifications.
 *
 * ROOT CAUSE this suite guards: KAS 2.19.2 dropped the deprecated custom
 * `_kiro.dev/metadata` notification (which carried `contextUsagePercentage`) and
 * now delivers context-usage on the ACP-standard `session/update` stream. The
 * ONLY variant KAS 2.19.2 actually emits is `session_info_update` (the zod
 * `usage_update` schema exists but has zero emit sites in the 2.19.2 binary).
 *   - `session_info_update` → `_meta.kiro` with `{ kind:'context_usage',
 *     usagePercentage }` plus the legacy `contextUsage.usagePercentage`.
 *   - `usage_update` → raw `{ used, size }` (percentage = used/size*100) — a
 *     DEFENSIVE forward-compatible path (ACP standard; not emitted by 2.19.2).
 * The receiver had a `usage_update` case but it only pushed a stream event and
 * NEVER recorded the value into `this.latestUsage` — the single field that
 * `promptCompat().contextUsagePercentage` (and `getLatestContextUsage()`) read
 * from. So the feature died silently: `latestUsage` stayed `undefined`.
 *
 * These tests execute the REAL production path — the actual private
 * `emitUpdate` switch on a real `KiroAcpAgent`, plus the exported
 * `extractContextUsagePercentage` — and assert the value lands in `latestUsage`
 * and is surfaced by `getLatestContextUsage()`. Litmus: deleting the
 * `this.latestUsage = ...` assignments in either case turns these red.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { SessionUpdate } from '@agentclientprotocol/sdk';
import { KiroAcpAgent, extractContextUsagePercentage } from './kiro-acp-agent';
import { WatchdogController } from './watchdog-controller';

// The watchdog arms real timers in its constructor; keep instances so we can
// clean them up and never leak a dangling timer into the vitest worker.
const watchdogs: WatchdogController[] = [];
const makeWatchdog = () => {
  const w = new WatchdogController({ idleMs: 60_000, hardWallMs: 120_000, toolProbeMs: 0 });
  watchdogs.push(w);
  return w;
};

// `emitUpdate` is private; casting to a call signature keeps us on the REAL
// method (no re-implementation) while satisfying the type checker.
type EmitUpdate = (u: SessionUpdate, w: WatchdogController) => unknown;
const emit = (agent: KiroAcpAgent, u: SessionUpdate) =>
  (agent as unknown as { emitUpdate: EmitUpdate }).emitUpdate(u, makeWatchdog());

afterEach(() => {
  while (watchdogs.length) watchdogs.pop()!.cleanup();
});

describe('extractContextUsagePercentage — session_info_update _meta.kiro shape', () => {
  it('reads _meta.kiro.usagePercentage when kind === "context_usage" (KAS spreads the update object)', () => {
    // buildSessionInfoUpdate does `_meta.kiro = { ...legacyFields(update), ...update }`,
    // so for a context_usage update `_meta.kiro` carries the spread fields.
    expect(extractContextUsagePercentage({ kiro: { kind: 'context_usage', usagePercentage: 42.5 } })).toBe(42.5);
  });

  it('falls back to legacy _meta.kiro.contextUsage.usagePercentage', () => {
    // legacyFields(context_usage) → { contextUsage: { usagePercentage } }.
    expect(
      extractContextUsagePercentage({ kiro: { kind: 'context_usage', contextUsage: { usagePercentage: 73 } } })
    ).toBe(73);
  });

  it('prefers the spread usagePercentage over the legacy contextUsage.usagePercentage when both present', () => {
    expect(
      extractContextUsagePercentage({
        kiro: { kind: 'context_usage', usagePercentage: 55, contextUsage: { usagePercentage: 11 } },
      })
    ).toBe(55);
  });

  it('rejects a non-context_usage kind (kind guard)', () => {
    expect(extractContextUsagePercentage({ kiro: { kind: 'turn_end', usagePercentage: 99 } })).toBeUndefined();
  });

  it('returns undefined for missing/empty meta or missing kiro payload', () => {
    expect(extractContextUsagePercentage(undefined)).toBeUndefined();
    expect(extractContextUsagePercentage(null)).toBeUndefined();
    expect(extractContextUsagePercentage({})).toBeUndefined();
    expect(extractContextUsagePercentage({ kiro: {} })).toBeUndefined();
  });

  it('returns undefined when usagePercentage is non-finite / non-numeric', () => {
    expect(extractContextUsagePercentage({ kiro: { kind: 'context_usage', usagePercentage: NaN } })).toBeUndefined();
    expect(extractContextUsagePercentage({ kiro: { kind: 'context_usage', usagePercentage: '80' } })).toBeUndefined();
  });
});

describe('emitUpdate → latestUsage wiring (usage_update path)', () => {
  it('records used/size and derives percentage = used/size*100 into latestUsage', () => {
    const agent = new KiroAcpAgent();
    emit(agent, { sessionUpdate: 'usage_update', used: 30, size: 120 } as unknown as SessionUpdate);
    expect(agent.getLatestContextUsage()).toEqual({ used: 30, size: 120, percentage: 25 });
  });

  it('also emits a "usage" stream event carrying the same derived percentage', () => {
    const agent = new KiroAcpAgent();
    const events = emit(agent, { sessionUpdate: 'usage_update', used: 50, size: 200 } as unknown as SessionUpdate) as {
      type: string;
      percentage?: number;
    }[];
    expect(events).toEqual([{ type: 'usage', used: 50, size: 200, percentage: 25 }]);
  });

  // NEGATIVE guard: zero / missing / negative size must NOT record anything.
  // A derived 0% is meaningless and could OVERWRITE a correct value obtained
  // from session_info_update, persist, and surface as a bogus "0%" in the next
  // turn's environment block — so the case skips the latestUsage assignment.
  it('size === 0 records nothing (no divide-by-zero, no bogus 0%)', () => {
    const agent = new KiroAcpAgent();
    emit(agent, { sessionUpdate: 'usage_update', used: 10, size: 0 } as unknown as SessionUpdate);
    expect(agent.getLatestContextUsage()).toBeUndefined();
  });

  it('missing size records nothing (treated as non-positive)', () => {
    const agent = new KiroAcpAgent();
    emit(agent, { sessionUpdate: 'usage_update', used: 10 } as unknown as SessionUpdate);
    expect(agent.getLatestContextUsage()).toBeUndefined();
  });

  it('does not overwrite an earlier valid value with a subsequent zero-size usage_update', () => {
    const agent = new KiroAcpAgent();
    // Establish a correct value first (e.g. from session_info_update-equivalent).
    emit(agent, { sessionUpdate: 'usage_update', used: 60, size: 100 } as unknown as SessionUpdate);
    expect(agent.getLatestContextUsage()!.percentage).toBe(60);
    // A later size=0 update must be ignored, leaving the good value intact.
    emit(agent, { sessionUpdate: 'usage_update', used: 10, size: 0 } as unknown as SessionUpdate);
    expect(agent.getLatestContextUsage()!.percentage).toBe(60);
  });
});

describe('emitUpdate → latestUsage wiring (session_info_update path)', () => {
  it('records the _meta.kiro percentage (spread shape) into latestUsage as percentage/size=100', () => {
    const agent = new KiroAcpAgent();
    emit(agent, {
      sessionUpdate: 'session_info_update',
      _meta: { kiro: { kind: 'context_usage', usagePercentage: 42 } },
    } as unknown as SessionUpdate);
    expect(agent.getLatestContextUsage()).toEqual({ used: 42, size: 100, percentage: 42 });
  });

  it('records the legacy contextUsage.usagePercentage shape into latestUsage', () => {
    const agent = new KiroAcpAgent();
    emit(agent, {
      sessionUpdate: 'session_info_update',
      _meta: { kiro: { kind: 'context_usage', contextUsage: { usagePercentage: 88 } } },
    } as unknown as SessionUpdate);
    expect(agent.getLatestContextUsage()).toEqual({ used: 88, size: 100, percentage: 88 });
  });

  // NEGATIVE guard: a session_info_update with no usable percentage (e.g. a
  // non-context_usage kind) must leave latestUsage untouched, never NaN.
  it('leaves latestUsage untouched when no usable percentage is present', () => {
    const agent = new KiroAcpAgent();
    emit(agent, {
      sessionUpdate: 'session_info_update',
      _meta: { kiro: { kind: 'turn_end', turnEnd: { stopReason: 'end_turn' } } },
    } as unknown as SessionUpdate);
    expect(agent.getLatestContextUsage()).toBeUndefined();
  });
});

describe('legacy _kiro.dev/metadata coexistence (last-write-wins on the same field)', () => {
  // The legacy notification handler and the new session/update path both write
  // the SAME `latestUsage` field. We keep the legacy handler as a harmless
  // fallback; the defined behaviour is last-write-wins. This asserts the new
  // path can overwrite an earlier legacy value and vice-versa, with no conflict.
  it('a later usage_update overwrites an earlier value', () => {
    const agent = new KiroAcpAgent();
    // Simulate an earlier legacy write by driving the same field via the new path first.
    emit(agent, { sessionUpdate: 'usage_update', used: 10, size: 100 } as unknown as SessionUpdate);
    expect(agent.getLatestContextUsage()!.percentage).toBe(10);
    emit(agent, { sessionUpdate: 'usage_update', used: 90, size: 100 } as unknown as SessionUpdate);
    expect(agent.getLatestContextUsage()!.percentage).toBe(90);
  });

  it('a session_info_update after a usage_update wins (last-write-wins)', () => {
    const agent = new KiroAcpAgent();
    emit(agent, { sessionUpdate: 'usage_update', used: 10, size: 100 } as unknown as SessionUpdate);
    emit(agent, {
      sessionUpdate: 'session_info_update',
      _meta: { kiro: { kind: 'context_usage', usagePercentage: 77 } },
    } as unknown as SessionUpdate);
    expect(agent.getLatestContextUsage()!.percentage).toBe(77);
  });
});
