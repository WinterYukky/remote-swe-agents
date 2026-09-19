import { describe, expect, test } from 'vitest';
import { buildAttachmentSentinel } from '@remote-swe-agents/agent-core/attachments';
import { applyToolResult, type ToolResultEventInput } from './apply-tool-result';
import {
  appendToolResultOutput,
  formatToolResultEntry,
  TOOL_RESULT_OUTPUT_SEPARATOR,
} from './build-tool-use-history-bubble';
import type { MessageView } from './MessageList';

/**
 * Builds a `toolUse` bubble exactly like SessionPageClient's `case 'toolUse'`
 * generic branch does: id = `${messageSK}-${toolUseId}`, type 'toolUse',
 * output undefined, and the toolUseId stamp the reducer matches on.
 */
function toolUseBubble(toolUseId: string, content = 'someTool', messageSK = '000000000000100'): MessageView {
  return {
    id: `${messageSK}-${toolUseId}`,
    role: 'assistant',
    content,
    detail: `${content}\n{}`,
    timestamp: new Date(parseInt(messageSK)),
    type: 'toolUse',
    toolUseId,
  };
}

/**
 * Builds the server-side history CLUSTER bubble that collapses a parallel tool
 * batch into one bubble carrying every id in `toolUseIds` (see
 * `build-tool-use-history-bubble.ts`). Its singular `toolUseId` is the first id.
 */
function clusterBubble(
  toolUseIds: string[],
  content = toolUseIds.join(' + '),
  messageSK = '000000000000100'
): MessageView {
  return {
    id: `${messageSK}-0`,
    role: 'assistant',
    content,
    detail: `${content}\n{}`,
    timestamp: new Date(parseInt(messageSK)),
    type: 'toolUse',
    toolUseId: toolUseIds[0],
    toolUseIds,
  };
}

function messageBubble(id: string, content = 'hi'): MessageView {
  return { id, role: 'assistant', content, timestamp: new Date(1000), type: 'message' };
}

function toolResultEvent(over: Partial<ToolResultEventInput> & { toolUseId: string }): ToolResultEventInput {
  return { toolName: 'someTool', output: 'done', ...over };
}

describe('applyToolResult — strict toolUseId matching', () => {
  test('attaches output to the toolUse bubble with the matching toolUseId', () => {
    const prev = [toolUseBubble('tc-1')];
    const next = applyToolResult(prev, toolResultEvent({ toolUseId: 'tc-1', output: 'RESULT' }));
    expect(next).not.toBe(prev); // immutable: new array
    expect(next[0].output).toBe('RESULT');
  });

  // The core regression: a silent agent-to-agent tool (renders NO
  // toolUse bubble) emits a toolResult. The OLD positional reducer attached it
  // to the last un-filled toolUse bubble (createNewSession), stealing its slot
  // and leaving createNewSession stuck on "Executing...". Strict matching must
  // make the silent toolResult a no-op.
  test('silent tool toolResult (no matching bubble) is a no-op and leaves createNewSession unfilled for its own result', () => {
    const prev = [toolUseBubble('tc-create', 'createNewSession')];

    // Silent sendMessageToAgent completes first (no bubble of its own).
    const afterSilent = applyToolResult(
      prev,
      toolResultEvent({ toolUseId: 'tc-agent', toolName: 'sendMessageToAgent', output: 'ack' })
    );
    expect(afterSilent).toBe(prev); // untouched — no bubble hijacked
    expect(afterSilent[0].output).toBeUndefined();

    // createNewSession's own toolResult then fills its bubble correctly.
    const afterCreate = applyToolResult(
      afterSilent,
      toolResultEvent({ toolUseId: 'tc-create', toolName: 'createNewSession', output: 'New session created' })
    );
    expect(afterCreate[0].output).toBe('New session created');
  });

  test('does not overwrite an already-filled output', () => {
    const prev = [{ ...toolUseBubble('tc-1'), output: 'FIRST' }];
    const next = applyToolResult(prev, toolResultEvent({ toolUseId: 'tc-1', output: 'SECOND' }));
    expect(next[0].output).toBe('FIRST');
    expect(next).toBe(prev); // nothing changed → same reference
  });

  test('appends imageKeys (deduped) to the matching bubble', () => {
    const prev = [{ ...toolUseBubble('tc-1'), imageKeys: ['a'] }];
    const next = applyToolResult(prev, toolResultEvent({ toolUseId: 'tc-1', imageKeys: ['a', 'b'] }));
    expect(next).not.toBe(prev);
    expect(next[0].imageKeys).toEqual(['a', 'b']);
  });

  test('no matching toolUseId among multiple bubbles → no-op', () => {
    const prev = [toolUseBubble('tc-1'), toolUseBubble('tc-2')];
    const next = applyToolResult(prev, toolResultEvent({ toolUseId: 'tc-missing' }));
    expect(next).toBe(prev);
    expect(next.every((m) => m.output === undefined)).toBe(true);
  });

  test('fills the correct bubble even when it is NOT the last toolUse (positional bug guard)', () => {
    // tc-early (createNewSession) precedes a later, already-filled toolUse.
    const prev = [
      toolUseBubble('tc-early', 'createNewSession', '000000000000100'),
      { ...toolUseBubble('tc-late', 'read_file', '000000000000200'), output: 'file contents' },
    ];
    const next = applyToolResult(prev, toolResultEvent({ toolUseId: 'tc-early', output: 'New session created' }));
    expect(next[0].output).toBe('New session created');
    expect(next[1].output).toBe('file contents'); // untouched
  });

  test('sendFileToUser attaches an image sentinel to its placeholder bubble', () => {
    const prev = [messageBubble('sendFileToUser-tc-file', 'here is your file')];
    const sentinelOutput = 'uploaded ' + buildAttachmentSentinel({ key: 'w1/pic.png', isImage: true });
    const next = applyToolResult(
      prev,
      toolResultEvent({ toolUseId: 'tc-file', toolName: 'sendFileToUser', output: sentinelOutput })
    );
    expect(next).not.toBe(prev);
    expect(next[0].imageKeys).toEqual(['w1/pic.png']);
  });

  test('sendFileToUser attaches a non-image sentinel as fileKeys', () => {
    const prev = [messageBubble('sendFileToUser-tc-file', 'here is your file')];
    const sentinelOutput = buildAttachmentSentinel({ key: 'w1/archive.zip', isImage: false });
    const next = applyToolResult(
      prev,
      toolResultEvent({ toolUseId: 'tc-file', toolName: 'sendFileToUser', output: sentinelOutput })
    );
    expect(next[0].fileKeys).toEqual(['w1/archive.zip']);
  });

  // Follow-up: a parallel batch (createNewSession + createEventTrigger
  // in one response) is collapsed by the server-side history builder into a
  // SINGLE cluster bubble carrying every id in `toolUseIds`. A realtime
  // toolResult for a batched tool that is NOT the singular `toolUseId` must
  // still attach to that shared bubble (previously it was a no-op and the
  // bubble stayed stuck on "Executing..." after router.refresh).
  test('matches a cluster bubble by a non-first id in toolUseIds', () => {
    const prev = [clusterBubble(['tc-create', 'tc-trigger'])];
    const next = applyToolResult(prev, toolResultEvent({ toolUseId: 'tc-trigger', output: 'trigger created' }));
    expect(next).not.toBe(prev);
    // A cluster bubble accumulates its results in the id-prefixed, joined
    // form (was previously the raw 'trigger created'); the first result of the
    // batch is just the single entry.
    expect(next[0].output).toBe(formatToolResultEntry('tc-trigger', 'trigger created'));
  });

  test('cluster bubble: an id in neither toolUseId nor toolUseIds is a no-op', () => {
    const prev = [clusterBubble(['tc-create', 'tc-trigger'])];
    const next = applyToolResult(prev, toolResultEvent({ toolUseId: 'tc-absent' }));
    expect(next).toBe(prev);
    expect(next[0].output).toBeUndefined();
  });

  // ===== cluster-bubble output live/reload format unification =====
  //
  // Goal: after applying a parallel batch's results LIVE, a cluster bubble's
  // `output` must equal the string the server-history builder (page.tsx)
  // produces on reload. Both sides now go through the SAME exported formatter
  // (formatToolResultEntry / TOOL_RESULT_OUTPUT_SEPARATOR), so we pin the live
  // result against that shared production logic — never a locally re-defined
  // format string (Test Effectiveness: this fails if either side drifts).

  test('accumulates a batch into the joined form and matches the shared builder output', () => {
    const prev = [clusterBubble(['tc-create', 'tc-trigger'])];
    // Results arrive in toolUseIds order (the common case: block order == arrival).
    let next = applyToolResult(prev, toolResultEvent({ toolUseId: 'tc-create', output: 'session created' }));
    next = applyToolResult(next, toolResultEvent({ toolUseId: 'tc-trigger', output: 'trigger created' }));

    // The exact string page.tsx builds on reload for the same batch:
    // results.map(formatToolResultEntry).join(SEP). Reproduce it via the SAME
    // exported functions the server path uses, so the two paths are pinned
    // together rather than to a hand-written literal.
    const serverForm = [
      formatToolResultEntry('tc-create', 'session created'),
      formatToolResultEntry('tc-trigger', 'trigger created'),
    ].join(TOOL_RESULT_OUTPUT_SEPARATOR);

    expect(next[0].output).toBe(serverForm);
  });

  test('appendToolResultOutput is the accumulation used by the live cluster path (first entry has no separator)', () => {
    // Guards that the live reducer really delegates to the shared accumulator:
    // applying one result to an empty cluster bubble equals appendToolResultOutput(undefined, ...).
    const prev = [clusterBubble(['tc-a', 'tc-b'])];
    const next = applyToolResult(prev, toolResultEvent({ toolUseId: 'tc-a', output: 'A' }));
    expect(next[0].output).toBe(appendToolResultOutput(undefined, 'tc-a', 'A'));
  });

  // Ordering parity decision: the live reducer appends in toolResult
  // ARRIVAL order, whereas the server history joins in message-content BLOCK
  // order (== toolUseIds order). For a truly parallel batch whose tools finish
  // out of order, the live emit (AfterToolCallEvent, per-tool completion) can
  // arrive reversed, so the live joined order can differ from the reload order.
  // We ACCEPT this residual order difference rather than add a structured
  // per-id accumulation buffer (which would duplicate state alongside `output`
  // and complicate the reconcileServerMessages carry-forward). Rationale:
  // is cosmetic, the reversal only occurs on genuinely concurrent completion,
  // both views still show every result id-prefixed, and a reload always
  // reaches the canonical block order. This test documents (does not "fix")
  // the reversed-arrival behaviour so a reviewer can weigh the tradeoff.
  test('[documented tradeoff] out-of-order arrival yields arrival-order join (not toolUseIds order)', () => {
    const prev = [clusterBubble(['tc-first', 'tc-second'])];
    // tc-second completes and emits BEFORE tc-first (reversed vs block order).
    let next = applyToolResult(prev, toolResultEvent({ toolUseId: 'tc-second', output: 'S' }));
    next = applyToolResult(next, toolResultEvent({ toolUseId: 'tc-first', output: 'F' }));

    const arrivalOrder = [formatToolResultEntry('tc-second', 'S'), formatToolResultEntry('tc-first', 'F')].join(
      TOOL_RESULT_OUTPUT_SEPARATOR
    );
    expect(next[0].output).toBe(arrivalOrder);
  });

  test('single-tool live bubble (no toolUseIds) keeps raw output — cluster scoping preserved', () => {
    // A plain live bubble carries only a singular toolUseId; it must NOT switch
    // to the id-prefixed joined form (scope guard for the format-unification change).
    const prev = [toolUseBubble('tc-1')];
    const next = applyToolResult(prev, toolResultEvent({ toolUseId: 'tc-1', output: 'raw output' }));
    expect(next[0].output).toBe('raw output');
  });

  // The append branch must be idempotent for a re-delivered
  // toolResult. The old singular path relied on `output === undefined`; the
  // cluster append path guards on the id already being present so a duplicate
  // event is a no-op with the same-reference semantics.
  test('re-delivered cluster toolResult (same id) is idempotent — no double append, same reference', () => {
    const prev = [clusterBubble(['tc-create', 'tc-trigger'])];
    const once = applyToolResult(prev, toolResultEvent({ toolUseId: 'tc-trigger', output: 'trigger created' }));
    expect(once[0].output).toBe(formatToolResultEntry('tc-trigger', 'trigger created'));

    // Same event delivered again: output unchanged AND the array is returned by
    // reference (no needless re-render), matching the no-op contract.
    const twice = applyToolResult(once, toolResultEvent({ toolUseId: 'tc-trigger', output: 'trigger created' }));
    expect(twice).toBe(once);
    expect(twice[0].output).toBe(formatToolResultEntry('tc-trigger', 'trigger created'));
  });

  test('idempotency guard is per-id: a duplicate of one batched result does not block the other', () => {
    const prev = [clusterBubble(['tc-create', 'tc-trigger'])];
    let next = applyToolResult(prev, toolResultEvent({ toolUseId: 'tc-create', output: 'session created' }));
    // duplicate of tc-create → no-op
    const dup = applyToolResult(next, toolResultEvent({ toolUseId: 'tc-create', output: 'session created' }));
    expect(dup).toBe(next);
    // the OTHER id still appends normally
    next = applyToolResult(dup, toolResultEvent({ toolUseId: 'tc-trigger', output: 'trigger created' }));
    expect(next[0].output).toBe(
      [
        formatToolResultEntry('tc-create', 'session created'),
        formatToolResultEntry('tc-trigger', 'trigger created'),
      ].join(TOOL_RESULT_OUTPUT_SEPARATOR)
    );
  });
});

const INTERNAL_WARNING =
  '\n<system>WARNING: Your previous response included text blocks alongside tool calls. These text blocks were NOT delivered to the user. If the text was intended for the user, you must resend it using the Send Message To User tool.</system>';

describe('applyToolResult — internal prompt text is stripped at display time', () => {
  test('single-tool live bubble: a <system> note in the event output is removed', () => {
    const prev = [toolUseBubble('tc-1')];
    const next = applyToolResult(
      prev,
      toolResultEvent({ toolUseId: 'tc-1', output: 'New session created successfully.' + INTERNAL_WARNING })
    );
    expect(next[0].output).toBe('New session created successfully.');
  });

  test('cluster bubble: each appended entry has its <system> note stripped', () => {
    const prev = [clusterBubble(['tc-create', 'tc-trigger'])];
    let next = applyToolResult(
      prev,
      toolResultEvent({ toolUseId: 'tc-create', output: 'session created' + INTERNAL_WARNING })
    );
    next = applyToolResult(
      next,
      toolResultEvent({ toolUseId: 'tc-trigger', output: 'trigger created' + INTERNAL_WARNING })
    );
    // Joined form carries the id-prefixed entries WITHOUT the internal notes.
    expect(next[0].output).toBe(
      [
        formatToolResultEntry('tc-create', 'session created'),
        formatToolResultEntry('tc-trigger', 'trigger created'),
      ].join(TOOL_RESULT_OUTPUT_SEPARATOR)
    );
  });

  test('ordinary output that merely mentions <result> is not corrupted on the live path', () => {
    const prev = [toolUseBubble('tc-1')];
    const passthrough = 'Here is <result> inside normal text';
    const next = applyToolResult(prev, toolResultEvent({ toolUseId: 'tc-1', output: passthrough }));
    expect(next[0].output).toBe(passthrough);
  });
});
