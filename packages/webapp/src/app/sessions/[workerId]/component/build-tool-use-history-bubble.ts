/**
 * @file Pure builder for the server-side `toolUse` history bubble.
 *
 * Why this exists: the live `toolResult` reducer
 * (`applyToolResult`) matches a realtime result to its bubble STRICTLY by
 * `toolUseId`. The live `toolUse` handler in `SessionPageClient` stamps that
 * id on every bubble it pushes, but the server-rendered history built in
 * `page.tsx` (used after `router.refresh()`) did NOT -- it collapsed all
 * visible tool calls of one assistant message into a single "a + b" cluster
 * bubble and stamped no id at all.
 *
 * The concrete failure: a parallel batch (e.g. `createNewSession` +
 * `createEventTrigger` emitted in one response) renders live as individual,
 * id-stamped bubbles, but a `router.refresh()` replaces them with ONE
 * id-less cluster bubble. The subsequent realtime `toolResult` events then
 * match no bubble (`m.toolUseId === event.toolUseId` never holds) and the
 * bubble stays stuck showing "Executing..." on the live screen. A reload,
 * which rebuilds from the DynamoDB SK chain with completed results already
 * attached, always rendered it correctly -- hence "DDB fine, reload clears".
 *
 * The fix stamps the cluster bubble with EVERY visible tool's `toolUseId`
 * (`toolUseIds`), plus the first as the singular `toolUseId` for parity with
 * the live single-bubble path. `applyToolResult` then attaches a result when
 * the event's id matches any of them, so a batch's per-tool results each
 * land on the shared cluster bubble and clear its "Executing..." state.
 *
 * The `name` join behaviour is unchanged: names are joined with ` + ` exactly
 * as before, and `name` is `string | undefined` to preserve the original
 * `Array.prototype.join` semantics (a missing name renders as an empty slot).
 *
 * Kept as a pure, client-safe module (mirrors `dedup.ts` / `apply-tool-result.ts`)
 * so it can be unit tested in isolation against the real builder the page uses.
 */
import type { MessageView } from './MessageList';

/** A single visible tool call within one assistant message. */
export type HistoryToolUseBlock = {
  name: string | undefined;
  toolUseId: string | undefined;
  input: unknown;
};

/**
 * Separator between the per-`toolResult` entries collected on a single toolUse
 * bubble's `output`. Single source of truth so the server-history builder
 * (`page.tsx`) and the live reducer (`apply-tool-result.ts`) render an
 * identical string for the same batch.
 */
export const TOOL_RESULT_OUTPUT_SEPARATOR = '\n\n';

/**
 * Format one `toolResult` into the canonical history line: the `toolUseId`
 * followed by the tool's textual output on the next line. This is the exact
 * shape `page.tsx` produces when rebuilding history from the DynamoDB SK chain,
 * exported so the live path can accumulate the same form instead of defining it
 * twice.
 */
export function formatToolResultEntry(toolUseId: string, text: string): string {
  return `${toolUseId}\n${text}`;
}

/**
 * Append one `toolResult` entry to an existing accumulated `output`, using the
 * canonical separator. An `undefined`/empty existing output yields just the
 * entry, so the first result of a batch and every subsequent one share one code
 * path and match the server-history joined form.
 */
export function appendToolResultOutput(existing: string | undefined, toolUseId: string, text: string): string {
  const entry = formatToolResultEntry(toolUseId, text);
  return existing ? `${existing}${TOOL_RESULT_OUTPUT_SEPARATOR}${entry}` : entry;
}

/**
 * Whether an accumulated cluster `output` already carries an entry for
 * `toolUseId`. Used by the live reducer to make a re-delivered `toolResult`
 * idempotent (the old `output === undefined` guard absorbed duplicates; the
 * append path must not double-append the same id).
 *
 * A duplicate is detected by splitting on the canonical separator and testing
 * whether any segment begins with the entry prefix `${toolUseId}\n` (every
 * entry starts with `formatToolResultEntry`'s id line). This is an intentional
 * approximation: a result whose text itself contains the separator can produce
 * extra segments, but a false match would require such a segment to begin with
 * the exact `${toolUseId}\n` prefix, which is not realistic for the unique
 * ACP toolCallIds we key on. Erring toward "already present" only ever turns a
 * genuine duplicate delivery into a no-op, which is the desired behaviour.
 */
export function outputContainsToolResultEntry(existing: string | undefined, toolUseId: string): boolean {
  if (!existing) {
    return false;
  }
  const prefix = `${toolUseId}\n`;
  return existing.split(TOOL_RESULT_OUTPUT_SEPARATOR).some((segment) => segment.startsWith(prefix));
}

export type BuildToolUseHistoryBubbleArgs = {
  /** Visible (non-hidden) tool calls of this assistant message, in order. */
  tools: HistoryToolUseBlock[];
  /** DynamoDB sort key of the source message item. */
  sk: string;
  /** Positional index of the message item (kept in the id for uniqueness). */
  index: number;
  thinkingBudget?: number;
};

/**
 * Build the history `toolUse` cluster bubble for one assistant message, or
 * `undefined` when there is no visible tool to render.
 *
 * The returned bubble mirrors the shape the page previously produced inline
 * (`content` = names joined with ` + `, `detail` = per-tool name/id/input),
 * with the addition of the `toolUseId` / `toolUseIds` stamps required for the
 * realtime reducer to attach results by id.
 */
export function buildToolUseHistoryBubble(args: BuildToolUseHistoryBubbleArgs): MessageView | undefined {
  const { tools, sk, index, thinkingBudget } = args;
  if (tools.length === 0) {
    return undefined;
  }

  const content = tools.map((block) => block.name).join(' + ');
  const detail = tools
    .map((block) => `${block.name} (${block.toolUseId})\n${JSON.stringify(block.input, undefined, 2)}`)
    .join('\n\n');

  const toolUseIds = tools.map((block) => block.toolUseId).filter((id): id is string => typeof id === 'string');

  return {
    id: `${sk}-${index}`,
    role: 'assistant',
    content,
    detail,
    timestamp: new Date(parseInt(sk)),
    type: 'toolUse',
    ...(toolUseIds.length > 0 ? { toolUseId: toolUseIds[0], toolUseIds } : {}),
    thinkingBudget,
  };
}
