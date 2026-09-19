import { describe, expect, test } from 'vitest';
import { agentColorClasses, agentInitials } from './agent-avatar';

describe('agentColorClasses (single-source identity color)', () => {
  test('is deterministic for the same session id', () => {
    expect(agentColorClasses('sess-A', 'Alice')).toEqual(agentColorClasses('sess-A', 'Alice'));
  });

  test('keys on session id, not name: same id + different name => same color', () => {
    expect(agentColorClasses('sess-A', 'Alice')).toEqual(agentColorClasses('sess-A', 'Bob'));
  });

  test('same display name but different session ids can differ (no name collision)', () => {
    // Two agents sharing the name "Agent" must be distinguishable by id.
    const a = agentColorClasses('sess-A', 'Agent');
    const b = agentColorClasses('sess-B', 'Agent');
    // Not guaranteed to differ (hash bucket), but must be stable per id.
    expect(agentColorClasses('sess-A', 'Agent')).toEqual(a);
    expect(agentColorClasses('sess-B', 'Agent')).toEqual(b);
  });

  test('falls back to name when session id is missing (legacy data)', () => {
    expect(agentColorClasses(undefined, 'Legacy')).toEqual(agentColorClasses(undefined, 'Legacy'));
  });

  test('every entry carries light and dark backgrounds and white text', () => {
    const c = agentColorClasses('sess-A', 'Alice');
    expect(c.bg).toMatch(/dark:bg-/);
    expect(c.bg).toMatch(/^bg-/);
    expect(c.text).toBe('text-white');
  });
});

describe('agentInitials', () => {
  test('takes up to two word initials, uppercased', () => {
    expect(agentInitials('Frontend Dev')).toBe('FD');
    expect(agentInitials('reviewer')).toBe('RE');
  });

  test('splits on spaces, underscores and hyphens', () => {
    expect(agentInitials('e2e_tester')).toBe('ET');
    expect(agentInitials('dev-ops')).toBe('DO');
  });

  test('falls back to "Agent" when name is empty/undefined', () => {
    expect(agentInitials(undefined)).toBe('AG');
    expect(agentInitials('')).toBe('AG');
  });
});
