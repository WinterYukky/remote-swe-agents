/**
 * @file Pure reducer for applying a realtime `toolResult` event onto the
 * currently-rendered chat bubbles.
 *
 * Why this exists (bug fix): the live `toolResult` handler used to attach the
 * result POSITIONALLY -- `findLastIndex(msg => msg.type === 'toolUse')` -- to
 * "the last toolUse bubble that still has no output", ignoring the event's
 * `toolUseId` entirely. That is fragile whenever a tool's `toolResult` is not
 * immediately preceded on screen by its own (and only its own) toolUse bubble.
 *
 * The concrete failure it caused: several tools emit a `toolResult` event but
 * render NO `toolUse` bubble (the agent-to-agent tools -- `sendMessageToAgent`,
 * `acknowledgeAgent`, `confirmSendToUser`, `confirmCompleteSession` -- are
 * silent in the local view, and the `sendMessageToUser` / `sendImageToUser`
 * families render a `message` bubble instead). A coordinator session that
 * calls `createNewSession` and then a silent `sendMessageToAgent` in the same
 * turn would have the silent tool's `toolResult` land on the `createNewSession`
 * toolUse bubble by position, so `createNewSession` never received its own
 * output and stayed stuck showing "Executing..." on the live screen (a reload,
 * which rebuilds from the DynamoDB SK chain, always rendered it correctly).
 *
 * The fix matches STRICTLY by `toolUseId`: the paired `toolUse` bubble is
 * stamped with `toolUseId`, and the result is attached to exactly that bubble.
 * A `toolResult` whose `toolUseId` matches no on-screen toolUse bubble (every
 * silent / message-family tool) is a no-op -- the failure mode above cannot
 * recur. The old blind tail fallback is removed.
 *
 * Kept as a pure, client-safe module (mirrors `dedup.ts`) so it can be unit
 * tested in isolation against the real reducer the component uses.
 */
import { toolNameInSet } from '@remote-swe-agents/agent-core/tool-name-utils';
import { parseAttachmentSentinel } from '@remote-swe-agents/agent-core/attachments';
import { appendToolResultOutput, outputContainsToolResultEntry } from './build-tool-use-history-bubble';
import { stripInternalPromptText } from './strip-internal-prompt-text';
import type { MessageView } from './MessageList';

/** The `toolResult` realtime event fields this reducer consumes. */
export type ToolResultEventInput = {
  toolUseId: string;
  toolName: string;
  output: string;
  imageKeys?: string[];
};

/** Tools whose live `toolUse` renders as a placeholder `message` bubble keyed
 *  `sendFileToUser-<id>`, so their `toolResult` attaches a sentinel there.
 *  Exported as the single source of truth; SessionPageClient imports this to
 *  avoid a drifting duplicate definition. */
export const SEND_FILE_TOOLS = new Set(['send_file_to_user', 'sendFileToUser', 'Send File To User']);

/**
 * Apply a `toolResult` event to the bubble list, returning a NEW array when a
 * bubble changed (immutable update so React re-renders -- the previously-shipped
 * bug where an in-place mutation made React bail out of rendering) or the same
 * reference when nothing matched.
 *
 * Matching rules:
 *   - `sendFileToUser`: the tool output embeds the canonical S3 key as a
 *     sentinel; attach it to the placeholder bubble keyed `sendFileToUser-<id>`
 *     that the `toolUse` handler pushed.
 *   - Every other tool: locate the `toolUse` bubble whose `toolUseId` equals
 *     the event's `toolUseId` and attach `output` (once) + any `imageKeys`.
 *   - No match: no-op. Silent (agent-to-agent) and message-family tools render
 *     no toolUse bubble, so their toolResult legitimately has no target.
 */
export function applyToolResult(messages: MessageView[], event: ToolResultEventInput): MessageView[] {
  let next = messages;

  if (toolNameInSet(event.toolName, SEND_FILE_TOOLS)) {
    const sentinel = parseAttachmentSentinel(event.output);
    if (sentinel) {
      const bubbleId = `sendFileToUser-${event.toolUseId}`;
      const idx = messages.findIndex((m) => m.id === bubbleId);
      if (idx >= 0) {
        next = [...messages];
        next[idx] = sentinel.isImage
          ? { ...next[idx]!, imageKeys: [sentinel.key] }
          : { ...next[idx]!, fileKeys: [sentinel.key] };
      }
    }
    return next;
  }

  // Match by toolUseId. ACP toolCallIds are unique within a session, so
  // exactly one toolUse bubble can carry a given id and "first" == "the" bubble.
  // If a future runtime ever REUSED a toolUseId, this attaches to the earliest
  // such bubble and a later duplicate would be left unfilled (no-op) — an
  // acceptable, non-crashing degradation, and strictly safer than the old
  // positional match that could hijack an unrelated bubble.
  //
  // A single bubble can also stand in for several tool calls: the server-side
  // history builder collapses a parallel tool batch (several tool calls in one
  // assistant message) into one cluster bubble that carries every id in
  // `toolUseIds`. Matching either the singular `toolUseId` or any entry of
  // `toolUseIds` lets each batched result clear the shared bubble's
  // "Executing..." state after a `router.refresh()` (live/refresh mismatch follow-up).
  const idx = messages.findIndex(
    (m) =>
      m.type === 'toolUse' && (m.toolUseId === event.toolUseId || (m.toolUseIds?.includes(event.toolUseId) ?? false))
  );
  if (idx < 0) {
    return next;
  }

  const target = messages[idx]!;
  const patch: Partial<MessageView> = {};
  // A cluster bubble (server-history origin, carrying `toolUseIds`) stands in
  // for several tool calls, so it accumulates each batched `toolResult` in the
  // same id-prefixed, `\n\n`-joined form the history builder produces — this
  // keeps the live and reloaded views byte-identical. A plain live
  // single-tool bubble (only a singular `toolUseId`, no `toolUseIds`) keeps its
  // existing behaviour: attach the raw output exactly once.
  // Strip internal, model-facing prompt text (`<system>...</system>` notes and
  // the Bedrock `renderToolResult` envelope) at display time so live and reload
  // render identically; DDB/model input are untouched.
  const displayOutput = stripInternalPromptText(event.output);
  if (target.toolUseIds && target.toolUseIds.length > 0) {
    // Idempotent append: a re-delivered `toolResult` for an id already present
    // in the accumulated output is a no-op, mirroring the singular path's
    // `output === undefined` guard (avoids double-appending the same entry).
    if (!outputContainsToolResultEntry(target.output, event.toolUseId)) {
      patch.output = appendToolResultOutput(target.output, event.toolUseId, displayOutput);
    }
  } else if (target.output === undefined) {
    patch.output = displayOutput;
  }
  if (event.imageKeys && event.imageKeys.length > 0) {
    const existing = new Set(target.imageKeys ?? []);
    const deduped = event.imageKeys.filter((k) => !existing.has(k));
    if (deduped.length > 0) {
      patch.imageKeys = [...(target.imageKeys ?? []), ...deduped];
    }
  }
  if (Object.keys(patch).length > 0) {
    next = [...messages];
    next[idx] = { ...target, ...patch };
  }
  return next;
}
