import { describe, it, expect } from 'vitest';
import { buildKiroAcpArgs, computeMandatoryMcpsEnv } from './kiro-acp-transport';

describe('buildKiroAcpArgs', () => {
  it('always produces v3 engine args', () => {
    const args = buildKiroAcpArgs({});
    expect(args).toEqual(['acp', '--agent-engine', 'v3']);
  });

  it('does not include --model, --trust-all-tools, or --agent (v3 rejects them)', () => {
    const args = buildKiroAcpArgs({ model: 'claude-sonnet-4.5', trustAllTools: true, agentName: 'foo' });
    expect(args).not.toContain('--model');
    expect(args).not.toContain('--trust-all-tools');
    expect(args).not.toContain('--agent');
  });
});

describe('computeMandatoryMcpsEnv (the MCP-exposure fix MCP tool-exposure gate)', () => {
  it('returns the session MCP server names as a comma list when nothing is inherited', () => {
    expect(computeMandatoryMcpsEnv(['remote-swe', 'fetch', 'playwright'], undefined)).toBe(
      'remote-swe,fetch,playwright'
    );
  });

  it('merges inherited operator value with session names, de-duplicated', () => {
    expect(computeMandatoryMcpsEnv(['remote-swe', 'fetch'], 'remote-swe,ops-server')).toBe(
      'remote-swe,ops-server,fetch'
    );
  });

  it('trims whitespace and drops empty entries from both sources', () => {
    expect(computeMandatoryMcpsEnv([' remote-swe ', '', '  '], '  , fetch ,')).toBe('fetch,remote-swe');
  });

  it('returns undefined when there is nothing to set (so the env var is omitted, not blanked)', () => {
    expect(computeMandatoryMcpsEnv([], undefined)).toBeUndefined();
    expect(computeMandatoryMcpsEnv(undefined, '')).toBeUndefined();
  });
});
