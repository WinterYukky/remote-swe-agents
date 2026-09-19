import { describe, expect, test } from 'vitest';
import { agentIconUrlForKey, hasResolvedIcon } from './agent-icon-url';

describe('agentIconUrlForKey', () => {
  test('builds the key-based /api/agent-icon URL when an icon key is configured', () => {
    expect(agentIconUrlForKey('icons/abc.png')).toBe('/api/agent-icon?key=icons%2Fabc.png');
  });

  test('url-encodes the key', () => {
    expect(agentIconUrlForKey('a b/c?d')).toBe('/api/agent-icon?key=a%20b%2Fc%3Fd');
  });

  test('returns null when no icon key (agent renders initials chip)', () => {
    expect(agentIconUrlForKey(undefined)).toBeNull();
    expect(agentIconUrlForKey(null)).toBeNull();
    expect(agentIconUrlForKey('')).toBeNull();
  });
});

describe('hasResolvedIcon (chip image-vs-initials branch)', () => {
  test('true only for a non-empty string url', () => {
    expect(hasResolvedIcon('/api/agent-icon?key=x')).toBe(true);
  });

  test('false for null (no icon), undefined (unresolved) and empty string', () => {
    expect(hasResolvedIcon(null)).toBe(false);
    expect(hasResolvedIcon(undefined)).toBe(false);
    expect(hasResolvedIcon('')).toBe(false);
  });
});
