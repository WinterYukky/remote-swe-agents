import { describe, expect, test } from 'vitest';
import {
  appendToolResultOutput,
  buildToolUseHistoryBubble,
  formatToolResultEntry,
  outputContainsToolResultEntry,
  TOOL_RESULT_OUTPUT_SEPARATOR,
  type HistoryToolUseBlock,
} from './build-tool-use-history-bubble';
import { applyToolResult } from './apply-tool-result';

const SK = '000000000000100';

function block(name: string | undefined, toolUseId: string | undefined, input: unknown = {}): HistoryToolUseBlock {
  return { name, toolUseId, input };
}

describe('buildToolUseHistoryBubble — stamps toolUseId(s) on the history cluster bubble', () => {
  test('returns undefined when there are no visible tools', () => {
    expect(buildToolUseHistoryBubble({ tools: [], sk: SK, index: 0 })).toBeUndefined();
  });

  test('single tool: joins name, stamps singular toolUseId AND toolUseIds', () => {
    const bubble = buildToolUseHistoryBubble({
      tools: [block('read_file', 'tc-1', { path: '/a' })],
      sk: SK,
      index: 2,
      thinkingBudget: 42,
    })!;
    expect(bubble.type).toBe('toolUse');
    expect(bubble.id).toBe(`${SK}-2`);
    expect(bubble.content).toBe('read_file');
    expect(bubble.detail).toContain('read_file (tc-1)');
    expect(bubble.toolUseId).toBe('tc-1');
    expect(bubble.toolUseIds).toEqual(['tc-1']);
    expect(bubble.thinkingBudget).toBe(42);
  });

  test('parallel batch: joins names with " + " and carries EVERY toolUseId', () => {
    const bubble = buildToolUseHistoryBubble({
      tools: [block('createNewSession', 'tc-create'), block('createEventTrigger', 'tc-trigger')],
      sk: SK,
      index: 0,
    })!;
    expect(bubble.content).toBe('createNewSession + createEventTrigger');
    // singular stamp is the first id (parity with the live single-bubble path)
    expect(bubble.toolUseId).toBe('tc-create');
    // the cluster carries all ids so the reducer can match any of them
    expect(bubble.toolUseIds).toEqual(['tc-create', 'tc-trigger']);
  });

  test('the bubble it builds lets applyToolResult clear a batched result by matching toolUseIds', () => {
    // The regression: after router.refresh the parallel batch
    // is a single cluster bubble. A realtime toolResult for the SECOND tool of
    // the batch (whose id is NOT the singular toolUseId) must still attach.
    const bubble = buildToolUseHistoryBubble({
      tools: [block('createNewSession', 'tc-create'), block('createEventTrigger', 'tc-trigger')],
      sk: SK,
      index: 0,
    })!;
    const prev = [bubble];
    const next = applyToolResult(prev, {
      toolUseId: 'tc-trigger',
      toolName: 'createEventTrigger',
      output: 'trigger created',
    });
    expect(next).not.toBe(prev); // immutable update produced a new array
    // A cluster bubble accumulates its results in the id-prefixed, joined
    // form; the first applied result is a single entry (no separator yet).
    expect(next[0].output).toBe(formatToolResultEntry('tc-trigger', 'trigger created'));
  });

  test('preserves join semantics when a name is undefined (name: string | undefined)', () => {
    const bubble = buildToolUseHistoryBubble({
      tools: [block(undefined, 'tc-x'), block('read_file', 'tc-y')],
      sk: SK,
      index: 1,
    })!;
    // Array.prototype.join renders undefined as an empty slot: " + read_file"
    expect(bubble.content).toBe(' + read_file');
    // ids with a defined value are still collected
    expect(bubble.toolUseIds).toEqual(['tc-x', 'tc-y']);
  });
});

describe('toolResult output formatting — shared by page.tsx (reload) and applyToolResult (live)', () => {
  test('formatToolResultEntry prefixes the toolUseId on its own line', () => {
    expect(formatToolResultEntry('tc-1', 'hello')).toBe('tc-1\nhello');
  });

  test('formatToolResultEntry preserves multi-line output verbatim', () => {
    expect(formatToolResultEntry('tc-1', 'line1\nline2')).toBe('tc-1\nline1\nline2');
  });

  test('appendToolResultOutput returns just the entry when there is no existing output', () => {
    expect(appendToolResultOutput(undefined, 'tc-1', 'A')).toBe(formatToolResultEntry('tc-1', 'A'));
    expect(appendToolResultOutput('', 'tc-1', 'A')).toBe(formatToolResultEntry('tc-1', 'A'));
  });

  test('appendToolResultOutput joins subsequent entries with the canonical separator', () => {
    const first = appendToolResultOutput(undefined, 'tc-1', 'A');
    const second = appendToolResultOutput(first, 'tc-2', 'B');
    expect(second).toBe(
      [formatToolResultEntry('tc-1', 'A'), formatToolResultEntry('tc-2', 'B')].join(TOOL_RESULT_OUTPUT_SEPARATOR)
    );
  });

  test('separator is the double newline the server history join uses', () => {
    expect(TOOL_RESULT_OUTPUT_SEPARATOR).toBe('\n\n');
  });
});

describe('outputContainsToolResultEntry — idempotency guard for the live cluster append', () => {
  test('undefined / empty output contains nothing', () => {
    expect(outputContainsToolResultEntry(undefined, 'tc-1')).toBe(false);
    expect(outputContainsToolResultEntry('', 'tc-1')).toBe(false);
  });

  test('detects an id that is the sole entry', () => {
    const out = appendToolResultOutput(undefined, 'tc-1', 'A');
    expect(outputContainsToolResultEntry(out, 'tc-1')).toBe(true);
    expect(outputContainsToolResultEntry(out, 'tc-2')).toBe(false);
  });

  test('detects an id in any position among multiple joined entries', () => {
    const out = appendToolResultOutput(appendToolResultOutput(undefined, 'tc-1', 'A'), 'tc-2', 'B');
    expect(outputContainsToolResultEntry(out, 'tc-1')).toBe(true);
    expect(outputContainsToolResultEntry(out, 'tc-2')).toBe(true);
    expect(outputContainsToolResultEntry(out, 'tc-3')).toBe(false);
  });

  test('does not match on a mere substring / different id sharing a prefix', () => {
    const out = appendToolResultOutput(undefined, 'tc-1', 'A');
    // 'tc-1' entry must not be seen as containing 'tc-12' or 'tc'
    expect(outputContainsToolResultEntry(out, 'tc-12')).toBe(false);
    expect(outputContainsToolResultEntry(out, 'tc')).toBe(false);
  });
});
