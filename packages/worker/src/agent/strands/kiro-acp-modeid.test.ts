import { describe, expect, it } from 'vitest';
import { buildKiroSessionMeta } from './kiro-acp-agent';

/**
 * the worker must select the deployed base worker agent profile via
 * `_meta.kiro.modeId` on both session/new and session/load. Without it the
 * session runs as a default vibe session whose tool policy filters out MCP
 * tools (includeMcpJson=false), so the remote-swe MCP tools never reach the
 * model. buildKiroSessionMeta is the single source of that payload for both
 * call sites; these tests execute it directly.
 */
describe('buildKiroSessionMeta (the MCP-exposure fix modeId wiring)', () => {
  it('emits _meta.kiro.modeId = agentName when an agent name is provided', () => {
    expect(buildKiroSessionMeta('remote-swe-worker')).toEqual({ kiro: { modeId: 'remote-swe-worker' } });
  });

  it('passes through a skill-declared agent name (precedence preserved upstream)', () => {
    expect(buildKiroSessionMeta('aidlc')).toEqual({ kiro: { modeId: 'aidlc' } });
  });

  it('returns undefined when agentName is undefined (the real-.kiro safeguard bail => no modeId, safe fallback)', () => {
    expect(buildKiroSessionMeta(undefined)).toBeUndefined();
  });

  it('returns undefined for an empty agent name (never sends a blank modeId)', () => {
    expect(buildKiroSessionMeta('')).toBeUndefined();
  });
});
