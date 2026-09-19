import { describe, expect, test } from 'vitest';
import { reconcileServerMessages } from './reconcile-server-messages';
import { applyToolResult, type ToolResultEventInput } from './apply-tool-result';
import type { MessageView } from './MessageList';

/** A server-history toolUse bubble (as page.tsx builds it): id `${SK}-${i}`,
 *  output undefined until DDB has the toolResult. `toolUseIds` carries every
 *  tool of a cluster (parallel batch collapsed into one bubble). */
function serverBubble(
  ids: string[],
  { sk = '000000000000100', index = 0, output }: { sk?: string; index?: number; output?: string } = {}
): MessageView {
  return {
    id: `${sk}-${index}`,
    role: 'assistant',
    content: ids.join(' + '),
    detail: ids.join(' + '),
    timestamp: new Date(parseInt(sk)),
    type: 'toolUse',
    toolUseId: ids[0],
    toolUseIds: ids,
    ...(output !== undefined ? { output } : {}),
  };
}

/** A live toolUse bubble as SessionPageClient's handler pushes it: id keyed
 *  `${messageSK}-${toolUseId}` (deliberately DIFFERENT from the server id so
 *  the reconciler must match by toolUseId, not by id). */
function liveBubble(toolUseId: string, sk = '000000000000100'): MessageView {
  return {
    id: `${sk}-${toolUseId}`,
    role: 'assistant',
    content: 'someTool',
    detail: 'someTool\n{}',
    timestamp: new Date(parseInt(sk)),
    type: 'toolUse',
    toolUseId,
  };
}

function messageBubble(id: string): MessageView {
  return { id, role: 'assistant', content: 'hi', timestamp: new Date(1000), type: 'message' };
}

function trEvent(over: Partial<ToolResultEventInput> & { toolUseId: string }): ToolResultEventInput {
  return { toolName: 'someTool', output: 'done', ...over };
}

describe('reconcileServerMessages — preserve live toolResult output across re-seed', () => {
  test('carries a live output onto a server bubble the server has not caught up on (matched by toolUseId, not id)', () => {
    const live = [{ ...liveBubble('tc-1'), output: 'LIVE OUTPUT' }];
    const server = [serverBubble(['tc-1'], { index: 0 })]; // server output still empty
    const next = reconcileServerMessages(server, live);
    expect(next[0].output).toBe('LIVE OUTPUT');
  });

  test('server output is authoritative once present — never overridden by live', () => {
    const live = [{ ...liveBubble('tc-1'), output: 'LIVE STALE' }];
    const server = [serverBubble(['tc-1'], { output: 'SERVER FRESH' })];
    const next = reconcileServerMessages(server, live);
    expect(next[0].output).toBe('SERVER FRESH');
  });

  test('a server bubble with no live match passes through unchanged (still Executing)', () => {
    const live = [messageBubble('unrelated')];
    const server = [serverBubble(['tc-1'])];
    const next = reconcileServerMessages(server, live);
    expect(next[0].output).toBeUndefined();
  });

  // The phase-3 regression, reproduced end-to-end against the REAL code path:
  // a parallel batch's two toolResults are applied live (applyToolResult), then
  // a router.refresh() re-seeds from a server history that has NEITHER output
  // yet (DDB race). The blind old re-seed (`setMessages(initialMessages)`)
  // would drop BOTH live outputs, leaving the tools stuck on "Executing...".
  // reconcileServerMessages must carry BOTH forward.
  test('parallel batch (2 separate items): both live outputs survive a re-seed with empty server bubbles', () => {
    // live view: two independent bubbles, each filled by its own toolResult.
    let live: MessageView[] = [liveBubble('tc-create', '000000000000278'), liveBubble('tc-trigger', '000000000000846')];
    live = applyToolResult(live, trEvent({ toolUseId: 'tc-create', output: 'session created' }));
    live = applyToolResult(live, trEvent({ toolUseId: 'tc-trigger', output: 'trigger created' }));
    expect(live.every((m) => m.output !== undefined)).toBe(true);

    // router.refresh() hands down server history where DDB has not caught up.
    const server = [
      serverBubble(['tc-create'], { sk: '000000000000278', index: 0 }),
      serverBubble(['tc-trigger'], { sk: '000000000000846', index: 1 }),
    ];
    const reseeded = reconcileServerMessages(server, live);
    expect(reseeded[0].output).toBe('session created');
    expect(reseeded[1].output).toBe('trigger created'); // the one that used to get clobbered
  });

  // e2e follow-up coverage requested by PM: the e32fb383 cluster path. When the
  // server collapses a parallel batch into ONE cluster bubble (toolUseIds has
  // several ids), reconcile must match a live output by ANY id — both the
  // singular stamp and any entry of toolUseIds.
  test('cluster server bubble: carries a live output matched via a non-first toolUseIds entry', () => {
    const live = [
      { ...liveBubble('tc-create'), output: 'session created' },
      { ...liveBubble('tc-trigger'), output: 'trigger created' },
    ];
    // one cluster bubble covering both; server output still empty
    const server = [serverBubble(['tc-create', 'tc-trigger'], { index: 0 })];
    const next = reconcileServerMessages(server, live);
    // first live match by toolUseId order wins for the single output slot
    expect(next[0].output).toBe('session created');
  });

  test('cluster server bubble matched by singular toolUseId when toolUseIds is absent', () => {
    const live = [{ ...liveBubble('tc-only'), output: 'only output' }];
    const server: MessageView[] = [
      {
        id: '000000000000100-0',
        role: 'assistant',
        content: 'someTool',
        detail: 'someTool',
        timestamp: new Date(100),
        type: 'toolUse',
        toolUseId: 'tc-only', // singular only, no toolUseIds array
      },
    ];
    const next = reconcileServerMessages(server, live);
    expect(next[0].output).toBe('only output');
  });

  test('live output indexed via a cluster bubble toolUseIds is carried onto a per-tool server bubble', () => {
    // live side is itself a cluster bubble (e.g. same-item batch) carrying ids;
    // server side split them per item. Match must still work.
    const liveCluster: MessageView = {
      id: '000000000000100-0',
      role: 'assistant',
      content: 'a + b',
      detail: 'a + b',
      timestamp: new Date(100),
      type: 'toolUse',
      toolUseId: 'tc-a',
      toolUseIds: ['tc-a', 'tc-b'],
      output: 'cluster output',
    };
    const server = [serverBubble(['tc-b'], { index: 0 })];
    const next = reconcileServerMessages(server, [liveCluster]);
    expect(next[0].output).toBe('cluster output');
  });

  test('carries toolResult-derived imageKeys (deduped) when the server bubble lacks them', () => {
    const live = [{ ...liveBubble('tc-1'), output: 'out', imageKeys: ['w1/a.png', 'w1/b.png'] }];
    const server = [{ ...serverBubble(['tc-1']), imageKeys: ['w1/a.png'] }];
    const next = reconcileServerMessages(server, live);
    expect(next[0].output).toBe('out');
    expect(next[0].imageKeys).toEqual(['w1/a.png', 'w1/b.png']);
  });

  test('returns the server array unchanged when there are no live outputs to carry', () => {
    const server = [serverBubble(['tc-1'])];
    const next = reconcileServerMessages(server, [messageBubble('x')]);
    expect(next).toBe(server);
  });
});
