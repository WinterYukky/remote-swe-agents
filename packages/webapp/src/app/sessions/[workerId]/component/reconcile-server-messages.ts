/**
 * @file Pure reconciliation of a freshly-rendered server history against the
 * bubbles currently on screen, preserving realtime `toolResult` output that
 * the server does not know about yet.
 *
 * Why this exists : after `router.refresh()` the Server
 * Component re-renders and hands down a new `initialMessages` built from the
 * DynamoDB SK chain. SessionPageClient used to re-seed unconditionally
 * (`setMessages(initialMessages)`), which OVERWROTE any `toolResult` output the
 * live event stream had already attached via `applyToolResult`.
 *
 * That is normally harmless because the server history usually already carries
 * the output. But a parallel tool batch emits two `toolResult` events almost
 * simultaneously, and a `router.refresh()` can land in the window BEFORE both
 * results are persisted to DynamoDB. The re-seed then replaces the live-filled
 * bubble with a server bubble whose `output` is still empty, so the tool stays
 * stuck on "Executing..." (`ToolUseRenderer` shows the spinner while
 * `output === undefined`). Which of the two batched tools loses the race, and
 * therefore stays stuck, varies run to run. A later reload clears it because by
 * then DynamoDB has caught up. This matched the phase-3 E2E symptom exactly.
 *
 * The fix keeps the server history as the source of truth for STRUCTURE (it
 * dedupes the live per-tool bubbles into the canonical cluster bubbles) but
 * carries forward the live `output` (and any `toolResult`-derived image keys)
 * for a tool the server has not yet caught up on. As soon as DynamoDB catches
 * up, the server bubble carries its own `output` and we defer to it — this
 * only ever fills a gap, never overrides the server.
 *
 * Matching is by `toolUseId`, NOT by bubble `id`: the live handler keys a
 * bubble `${messageSK}-${toolUseId}` while the server cluster keys it
 * `${SK}-${index}`, so the ids do not line up. Both the singular `toolUseId`
 * and every entry of `toolUseIds` (parallel-batch cluster) are indexed.
 *
 * Kept as a pure, client-safe module (mirrors `dedup.ts` /
 * `apply-tool-result.ts`) so it can be unit tested in isolation.
 */
import type { MessageView } from './MessageList';

type CarriedOutput = {
  output: string;
  imageKeys?: string[];
};

/** Collect, keyed by every toolUseId it covers, the live `output` of each
 *  on-screen toolUse bubble that already has one. */
function indexLiveOutputs(prev: MessageView[]): Map<string, CarriedOutput> {
  const byToolUseId = new Map<string, CarriedOutput>();
  for (const m of prev) {
    if (m.type !== 'toolUse' || m.output === undefined) continue;
    const carried: CarriedOutput = { output: m.output, imageKeys: m.imageKeys };
    const ids = [m.toolUseId, ...(m.toolUseIds ?? [])].filter((id): id is string => typeof id === 'string');
    for (const id of ids) {
      if (!byToolUseId.has(id)) {
        byToolUseId.set(id, carried);
      }
    }
  }
  return byToolUseId;
}

/**
 * Reconcile the incoming server history with the current on-screen bubbles.
 *
 * Returns a NEW array where every server `toolUse` bubble that is still missing
 * its `output` inherits the live-applied `output` (and any not-yet-present
 * `imageKeys`) of a bubble covering the same `toolUseId`. Server bubbles that
 * already have an `output` are left untouched (server is authoritative once it
 * has caught up). Non-toolUse bubbles and bubbles with no live match pass
 * through verbatim, so the server history remains the structural source of
 * truth.
 */
export function reconcileServerMessages(serverMessages: MessageView[], prev: MessageView[]): MessageView[] {
  const liveOutputs = indexLiveOutputs(prev);
  if (liveOutputs.size === 0) {
    return serverMessages;
  }

  return serverMessages.map((server) => {
    if (server.type !== 'toolUse' || server.output !== undefined) {
      return server;
    }
    const ids = [server.toolUseId, ...(server.toolUseIds ?? [])].filter((id): id is string => typeof id === 'string');
    const carried = ids.map((id) => liveOutputs.get(id)).find((c): c is CarriedOutput => c !== undefined);
    if (!carried) {
      return server;
    }
    const patched: MessageView = { ...server, output: carried.output };
    if (carried.imageKeys && carried.imageKeys.length > 0) {
      const existing = new Set(server.imageKeys ?? []);
      const merged = [...(server.imageKeys ?? []), ...carried.imageKeys.filter((k) => !existing.has(k))];
      patched.imageKeys = merged;
    }
    return patched;
  });
}
