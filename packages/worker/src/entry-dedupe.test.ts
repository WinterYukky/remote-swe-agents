/**
 * First-turn dedupe guard — shouldSkipDuplicateStart
 * ============================================
 * Guards the boot-`startResume` vs unicast-`onMessageReceived` race: two turn
 * starts for the SAME trigger message must collapse to one (skip the second),
 * while a genuinely NEW trigger must still cancel+restart, and the legitimate
 * stop->resume path (no running session) must always start.
 *
 * Executes the REAL exported decision function (Test Effectiveness Rule); no
 * simulation. entry.ts top-level side effects (Amplify.configure, ws) are
 * neutralised by env + light Amplify/events mocks so the module imports in
 * vitest without reaching AWS.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

beforeAll(() => {
  process.env.EVENT_HTTP_ENDPOINT ??= 'https://example.invalid';
  process.env.AWS_REGION ??= 'ap-northeast-1';
});
vi.mock('aws-amplify', () => ({ Amplify: { configure: vi.fn() } }));
vi.mock('aws-amplify/data', () => ({ events: { connect: vi.fn() } }));

import { shouldSkipDuplicateStart } from './entry';

type S = { isFinished: boolean; triggerSK?: string };

describe('shouldSkipDuplicateStart', () => {
  it('SKIPS when a running session already processes the same trigger SK (the race)', () => {
    const sessions: S[] = [{ isFinished: false, triggerSK: '000000000000100' }];
    expect(shouldSkipDuplicateStart(sessions, '000000000000100')).toBe(true);
  });

  it('PROCEEDS (cancel+restart) when the running session has a DIFFERENT trigger SK (new message)', () => {
    // Requirement (b): a genuinely new user message mid-turn must still
    // cancel+restart -- the interrupt flow the #327 E2E depends on.
    const sessions: S[] = [{ isFinished: false, triggerSK: '000000000000100' }];
    expect(shouldSkipDuplicateStart(sessions, '000000000000200')).toBe(false);
  });

  it('PROCEEDS when there is no running session (stop->resume / first boot)', () => {
    // Requirement (a): the legitimate resume path must always start when
    // nothing is running (or the only session already finished).
    expect(shouldSkipDuplicateStart([], '000000000000100')).toBe(false);
    expect(shouldSkipDuplicateStart([{ isFinished: true, triggerSK: '000000000000100' }], '000000000000100')).toBe(
      false
    );
  });

  it('PROCEEDS when the incoming trigger SK is undefined (cannot prove identity -> fail-open)', () => {
    const sessions: S[] = [{ isFinished: false, triggerSK: '000000000000100' }];
    expect(shouldSkipDuplicateStart(sessions, undefined)).toBe(false);
  });

  it('SKIPS on a live match even when a finished session also had that SK', () => {
    const sessions: S[] = [
      { isFinished: true, triggerSK: '000000000000100' },
      { isFinished: false, triggerSK: '000000000000100' },
    ];
    expect(shouldSkipDuplicateStart(sessions, '000000000000100')).toBe(true);
  });

  it('PROCEEDS when a live session has an undefined triggerSK (identity unknown -> do not skip)', () => {
    const sessions: S[] = [{ isFinished: false, triggerSK: undefined }];
    expect(shouldSkipDuplicateStart(sessions, '000000000000100')).toBe(false);
  });
});
