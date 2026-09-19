/**
 * @file Display-only filter that removes internal, model-facing prompt text
 * from a tool result before it is shown in the chat UI.
 *
 * Why this exists: the worker persists some
 * text into a `toolResult` that is meant for the MODEL, not the user:
 *
 *  1. `<system>...</system>` notes — e.g. the kiro-cli loop appends
 *     `NON_EMPTY_DISCARD_WARNING` ("<system>WARNING: Your previous response
 *     included text blocks alongside tool calls ...</system>") to the persisted
 *     tool result so the model re-sends dropped text next turn. The live event
 *     omits it, so it only surfaces after a reload — confirmed present in real
 *     DynamoDB tool-result items.
 *  2. The Bedrock path's `renderToolResult` envelope — it wraps a string tool
 *     result as `<result>\n{output}\n</result>\n<command>\n{forceReportMessage}\n</command>`
 *     before persisting; the `<command>` carries a model-facing "report progress"
 *     nudge. (Code path confirmed end-to-end; no live Bedrock session currently
 *     exists in DynamoDB to sample because the deployment runs kiro-cli — see the
 *     live incident. Envelope handling is therefore pinned by tests, not
 *     by a live sample.)
 *
 * These are internal to the agent runtime and must not be rendered verbatim to
 * the user. This filter removes them at DISPLAY time only — the DynamoDB history
 * and the model's input are untouched. It is applied identically on the live
 * path (`applyToolResult`) and the reload path (`page.tsx`), so the two views
 * stay byte-identical (live/reload parity).
 *
 * DESIGN — bias to leaving text ALONE (per PM constraint): every transform here
 * only fires when the text matches the exact envelope/tag shape the worker
 * emits. Any ambiguity resolves to passthrough (return the text unchanged) so
 * ordinary tool output that merely happens to contain `<result>` or `<system>`
 * is never corrupted.
 *
 * Kept as a pure, client-safe module (mirrors `dedup.ts` /
 * `apply-tool-result.ts`) so it can be unit tested in isolation. It deliberately
 * does NOT import the worker/agent-core producers (their `renderToolResult`
 * lives behind a server-only barrel that pulls in fs/ddb); the envelope shape is
 * matched structurally here and pinned by tests.
 */

/**
 * Unwrap the Bedrock `renderToolResult` envelope ONLY when the ENTIRE `text` is
 * exactly one such envelope; otherwise return `text` unchanged.
 *
 * Shape produced by `renderToolResult` (agent-core `lib/prompt.ts`) after its
 * trailing `.trim()`:
 *
 *   <result>
 *   {toolResult}
 *   </result>
 *   <command>
 *   {forceReportMessage}
 *   </command>
 *
 * `{forceReportMessage}` is empty when the forceReport timer has not fired. We
 * return just the inner `{toolResult}`; the `<command>` block (a model-facing
 * progress nudge) is dropped. The regex is anchored at both ends (`^`/`$`) so a
 * `<result>` appearing partway through normal output does NOT trigger unwrap —
 * passthrough is the default.
 */
function unwrapRenderToolResultEnvelope(text: string): string {
  // Whole-string envelope only. `[\s\S]*?` (non-greedy) for the result body
  // stops at the first `\n</result>\n<command>\n`; the command body runs to the
  // final `</command>` immediately before the end anchor. Missing/mismatched
  // markers => no match => passthrough.
  const envelope = /^<result>\n([\s\S]*?)\n<\/result>\n<command>\n[\s\S]*<\/command>$/;
  const m = envelope.exec(text);
  return m ? m[1]! : text;
}

/**
 * Remove `<system>...</system>` notes the worker appends to a tool result
 * (e.g. `NON_EMPTY_DISCARD_WARNING`). Only a `<system>...</system>` pair whose
 * inner text stays ON A SINGLE LINE is removed — which is the exact shape the
 * worker emits: `NON_EMPTY_DISCARD_WARNING` (kiro-loop-helpers.ts) is
 * `'\n<system>WARNING: ... tool.</system>'`, whose inner contains NO newline
 * (verified against the real constant). The worker prepends a newline before
 * the tag (and the reload join adds another), so optional leading spaces/tabs
 * and ALL preceding newlines are swallowed to avoid a dangling blank line and to
 * keep the live/reload results byte-identical.
 *
 * Constraining the inner to `[^\n]` (rather than `[\s\S]`) is what makes the
 * removal safe against legitimate output: a lone `<system>` on one line and a
 * stray `</system>` on a LATER line must NOT pair up and delete the text between
 * them (E2E-c regression). Any cross-line or unbalanced case therefore falls
 * through as passthrough — the conservative choice, and a superset of the "lone
 * tag is left alone" contract.
 */
function stripSystemBlocks(text: string): string {
  // `[^\n]*?` (non-greedy, no newline) bounds the inner to a single line, so a
  // removal can only happen when the matching `</system>` is on the SAME line as
  // its `<system>` — exactly the worker's WARNING shape. `g` clears every such
  // occurrence. `\n*` (not `\n?`) before the tag swallows every preceding blank
  // line so the stripped reload text is byte-identical to the live text.
  return text.replace(/[ \t]*\n*<system>[^\n]*?<\/system>/g, '');
}

/**
 * Strip internal, model-facing prompt text from a single tool result's output
 * for display. Pure and idempotent. Returns ordinary output unchanged (modulo a
 * trailing-whitespace trim, below), and leaves any ambiguous/partial markup
 * untouched (passthrough-biased).
 *
 * The final `trimEnd()` is applied UNCONDITIONALLY on this shared path (used by
 * both the live reducer and the reload builder). It is what guarantees true
 * byte parity when the tool output ITSELF ends in a newline AND a warning is
 * attached: the reload text is `output + '\n' + WARNING` (WARNING starts with
 * '\n'), so `stripSystemBlocks` removes the warning and every preceding newline
 * — INCLUDING the output's own trailing '\n' — yielding `output.trimEnd()`. The
 * live path never carries the warning, so its raw `output` (e.g. "hello\n")
 * would keep that '\n' and diverge. A trim gated on "did we strip something"
 * would NOT help (live strips nothing), so the trim must be unconditional on the
 * shared function so both paths normalise a trailing newline identically.
 * Display impact is limited to trailing whitespace/newlines (invisible in the
 * `<pre>` accordion). This supersedes the earlier note that avoided trimEnd —
 * that concern was about trimming only ONE path; applying it to BOTH via this
 * shared function is safe and is the true fix.
 */
export function stripInternalPromptText(text: string): string {
  const unwrapped = unwrapRenderToolResultEnvelope(text);
  return stripSystemBlocks(unwrapped).trimEnd();
}
