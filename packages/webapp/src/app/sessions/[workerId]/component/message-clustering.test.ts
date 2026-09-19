import { describe, expect, test } from 'vitest';
import {
  isToolClusterRunning,
  runningToolName,
  hashTargetInMessages,
  paddedMessageSk,
  isActivityMessage,
  activityBreakdown,
  groupMessages,
  getMessageSenderKey,
  shouldClusterActivity,
  ACTIVITY_CLUSTER_MIN,
} from './message-clustering';
import type { MessageView } from './MessageList';

const mk = (id: string, type: MessageView['type'], extra: Partial<MessageView> = {}): MessageView =>
  ({
    id,
    role: 'assistant',
    content: type === 'toolUse' ? 'Execute Command' : 'text',
    timestamp: new Date(0),
    type,
    ...extra,
  }) as MessageView;

describe('isActivityMessage', () => {
  test('tool / event / agent messages are activity; content messages are not', () => {
    expect(isActivityMessage(mk('1', 'toolUse'))).toBe(true);
    expect(isActivityMessage(mk('2', 'toolResult'))).toBe(true);
    expect(isActivityMessage(mk('3', 'eventTrigger'))).toBe(true);
    expect(isActivityMessage(mk('4', 'agentMessage'))).toBe(true);
    expect(isActivityMessage(mk('5', 'message'))).toBe(false);
  });
});

describe('activityBreakdown', () => {
  test('counts each kind; the user example tool2/agent3/tool1/event1/agent1', () => {
    const msgs = [
      mk('t1', 'toolUse'),
      mk('t2', 'toolUse'),
      mk('a1', 'agentMessage'),
      mk('a2', 'agentMessage'),
      mk('a3', 'agentMessage'),
      mk('t3', 'toolUse'),
      mk('e1', 'eventTrigger'),
      mk('a4', 'agentMessage'),
    ];
    expect(activityBreakdown(msgs)).toEqual({ agents: 4, tools: 3, events: 1 });
  });

  test('toolResult counts toward tools; empty run is all zero', () => {
    expect(activityBreakdown([mk('r', 'toolResult')])).toEqual({ agents: 0, tools: 1, events: 0 });
    expect(activityBreakdown([])).toEqual({ agents: 0, tools: 0, events: 0 });
  });
});

describe('isToolClusterRunning / runningToolName', () => {
  test('running when a toolUse has no output yet', () => {
    const msgs = [
      mk('1', 'toolUse', { output: 'done' }),
      mk('2', 'toolUse', { output: undefined, content: 'Read File' }),
    ];
    expect(isToolClusterRunning(msgs)).toBe(true);
    expect(runningToolName(msgs)).toBe('Read File');
  });

  test('not running when every toolUse has output', () => {
    const msgs = [mk('1', 'toolUse', { output: 'a' }), mk('2', 'toolUse', { output: 'b' })];
    expect(isToolClusterRunning(msgs)).toBe(false);
    expect(runningToolName(msgs)).toBeUndefined();
  });
});

describe('hashTargetInMessages (search-jump auto-expand)', () => {
  const m1 = mk('900000000000001-2', 'agentMessage', { timestamp: new Date(1000) });
  const m2 = mk('900000000000002-0', 'agentMessage', { timestamp: new Date(2000) });
  const msgs = [m1, m2];

  test('matches exact message id', () => {
    expect(hashTargetInMessages(msgs, '#msg-900000000000002-0')).toBe(true);
  });

  test('matches an SK that is a prefix of the message id (msg-<SK> id-prefix mode)', () => {
    expect(hashTargetInMessages(msgs, '#msg-900000000000001')).toBe(true);
  });

  test('matches the 15-digit padded timestamp (data-msg-sk mode)', () => {
    expect(hashTargetInMessages([m1], `#msg-${paddedMessageSk(m1)}`)).toBe(true);
    expect(paddedMessageSk(m1)).toBe('000000000001000');
  });

  test('no match / non-msg hash / empty returns false', () => {
    expect(hashTargetInMessages(msgs, '#msg-999999999999999')).toBe(false);
    expect(hashTargetInMessages(msgs, '#something')).toBe(false);
    expect(hashTargetInMessages(msgs, '')).toBe(false);
    expect(hashTargetInMessages(msgs, undefined)).toBe(false);
  });
});

describe('groupMessages (grouping boundary rules)', () => {
  const kinds = (msgs: MessageView[]) => groupMessages(msgs).map((g) => g.kind);
  const sizes = (msgs: MessageView[]) => groupMessages(msgs).map((g) => g.messages.length);

  test('a content message breaks an activity run', () => {
    // tool,tool -> assistant text -> tool  ==> activity(2), content(1), activity(1)
    const msgs = [
      mk('t1', 'toolUse'),
      mk('t2', 'toolUse'),
      mk('a', 'message', { role: 'assistant' }),
      mk('t3', 'toolUse'),
    ];
    expect(kinds(msgs)).toEqual(['activity', 'content', 'activity']);
    expect(sizes(msgs)).toEqual([2, 1, 1]);
  });

  test('mixed activity kinds do NOT break: one activity group', () => {
    const msgs = [mk('t1', 'toolUse'), mk('a1', 'agentMessage'), mk('e1', 'eventTrigger'), mk('r1', 'toolResult')];
    expect(kinds(msgs)).toEqual(['activity']);
    expect(sizes(msgs)).toEqual([4]);
  });

  test('an assistant text message is separate from the tools that follow it', () => {
    const msgs = [mk('a', 'message', { role: 'assistant' }), mk('t1', 'toolUse'), mk('t2', 'toolUse')];
    expect(kinds(msgs)).toEqual(['content', 'activity']);
    expect(sizes(msgs)).toEqual([1, 2]);
  });

  test('consecutive user messages from DIFFERENT senders split into separate content groups', () => {
    const alice = mk('u1', 'message', { role: 'user', userSenderType: 'slack', userSenderUserId: 'alice' });
    const bob = mk('u2', 'message', { role: 'user', userSenderType: 'slack', userSenderUserId: 'bob' });
    expect(kinds([alice, bob])).toEqual(['content', 'content']);
  });

  test('consecutive user messages from the SAME sender merge into one content group', () => {
    const a1 = mk('u1', 'message', { role: 'user', userSenderType: 'slack', userSenderUserId: 'alice' });
    const a2 = mk('u2', 'message', { role: 'user', userSenderType: 'slack', userSenderUserId: 'alice' });
    expect(sizes([a1, a2])).toEqual([2]);
  });

  test('empty input yields no groups', () => {
    expect(groupMessages([])).toEqual([]);
  });
});

describe('getMessageSenderKey (stable sender key)', () => {
  test('assistant/tool/event collapse onto one assistant bucket per agentName', () => {
    expect(getMessageSenderKey(mk('1', 'toolUse', { role: 'assistant' }))).toBe('assistant:');
    expect(getMessageSenderKey(mk('2', 'message', { role: 'assistant' }))).toBe('assistant:');
  });

  test('user messages keyed by sender type + id; different ids differ, same id stable', () => {
    const a = mk('1', 'message', { role: 'user', userSenderType: 'slack', userSenderUserId: 'alice' });
    const b = mk('2', 'message', { role: 'user', userSenderType: 'slack', userSenderUserId: 'bob' });
    expect(getMessageSenderKey(a)).toBe('user:slack:alice');
    expect(getMessageSenderKey(a)).toBe(getMessageSenderKey({ ...a, id: 'x' } as MessageView));
    expect(getMessageSenderKey(a)).not.toBe(getMessageSenderKey(b));
  });
});

describe('shouldClusterActivity / ACTIVITY_CLUSTER_MIN', () => {
  test('threshold is 2; activity group clusters at >= 2, single stays bare', () => {
    expect(ACTIVITY_CLUSTER_MIN).toBe(2);
    expect(shouldClusterActivity({ kind: 'activity', messages: [mk('1', 'toolUse')] })).toBe(false);
    expect(shouldClusterActivity({ kind: 'activity', messages: [mk('1', 'toolUse'), mk('2', 'toolUse')] })).toBe(true);
  });

  test('content groups never cluster', () => {
    expect(shouldClusterActivity({ kind: 'content', messages: [mk('1', 'message'), mk('2', 'message')] })).toBe(false);
  });
});
