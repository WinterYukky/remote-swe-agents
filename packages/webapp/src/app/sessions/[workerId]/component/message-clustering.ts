import type { MessageView, MessageGroup } from './MessageList';

/**
 * Whether a tool cluster contains a still-executing tool (a `toolUse` whose
 * `output` has not arrived yet). Such a cluster belongs to the in-progress
 * turn and is kept expanded with a running indicator; a fully-completed
 * cluster defaults to collapsed.
 */
export function isToolClusterRunning(messages: MessageView[]): boolean {
  return messages.some((m) => m.type === 'toolUse' && m.output === undefined);
}

/**
 * Name of the currently-executing tool in a running cluster (the last
 * `toolUse` without output), used for the "running <tool>…" header label.
 * Returns undefined when nothing is executing.
 */
export function runningToolName(messages: MessageView[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.type === 'toolUse' && m.output === undefined) return m.content;
  }
  return undefined;
}

/**
 * The 15-digit, zero-padded anchor id `MessageItem` stamps as `data-msg-sk`
 * (from the message timestamp). Kept here next to the clustering logic so the
 * hash-jump membership test below stays a pure, node-testable function.
 */
export function paddedMessageSk(message: MessageView): string {
  return String(message.timestamp.getTime()).padStart(15, '0');
}

/**
 * Whether a search-jump hash (`#msg-<SK>`) targets one of `messages`. Mirrors
 * the three matching modes of `MessageList.scrollToHash`:
 *   - exact element id `msg-<message.id>`
 *   - `data-msg-sk` equal to the 15-digit padded timestamp
 *   - id prefix `msg-<SK>` (SK is a prefix of `message.id`)
 * A collapsed cluster whose member matches must auto-expand so the jump can
 * land on the (now-mounted, visible) anchor.
 */
export function hashTargetInMessages(messages: MessageView[], hash: string | undefined): boolean {
  if (!hash || !hash.startsWith('#msg-')) return false;
  const sk = hash.slice('#msg-'.length);
  if (!sk) return false;
  return messages.some((m) => m.id === sk || m.id.startsWith(sk) || paddedMessageSk(m) === sk);
}

/**
 * The message types that make up an "activity" run (as opposed to real
 * content messages, i.e. `type === 'message'`, which break the run). A
 * maximal run of >= TOOL_CLUSTER_MIN consecutive activity messages is
 * collapsed into a single mixed "activity cluster" whose header shows a
 * per-kind breakdown; content messages (assistant text / user messages)
 * always break the run.
 */
export const isActivityMessage = (m: MessageView): boolean =>
  m.type === 'toolUse' || m.type === 'toolResult' || m.type === 'eventTrigger' || m.type === 'agentMessage';

export type ActivityBreakdown = {
  agents: number;
  tools: number;
  events: number;
};

/**
 * Per-kind counts for an activity cluster header. `agents` counts
 * agent-to-agent messages, `tools` counts tool calls (toolUse/toolResult),
 * `events` counts event triggers.
 */
export const activityBreakdown = (messages: MessageView[]): ActivityBreakdown => {
  const breakdown: ActivityBreakdown = { agents: 0, tools: 0, events: 0 };
  for (const m of messages) {
    if (m.type === 'agentMessage') breakdown.agents++;
    else if (m.type === 'toolUse' || m.type === 'toolResult') breakdown.tools++;
    else if (m.type === 'eventTrigger') breakdown.events++;
  }
  return breakdown;
};

/**
 * Minimum number of messages in an 'activity' group before it renders as a
 * collapsed cluster; a lone activity message renders bare. Kept as a named
 * constant so the threshold is tunable and unit-testable.
 */
export const ACTIVITY_CLUSTER_MIN = 2;

/** Whether an 'activity' group should render as a collapsible cluster. */
export const shouldClusterActivity = (group: Pick<MessageGroup, 'kind' | 'messages'>): boolean =>
  group.kind === 'activity' && group.messages.length >= ACTIVITY_CLUSTER_MIN;

/**
 * Derive a stable key that identifies the *sender* of a message for the
 * purpose of grouping consecutive bubbles. Two messages with the same key
 * come from the same source and may share a content group; different keys
 * force a new group.
 *
 * - assistant / tool / event messages collapse onto a single 'assistant'
 *   bucket per `agentName` (role+agentName check covers this).
 * - user messages are keyed by `userSenderType + userSenderUserId`, falling
 *   back to displayName, then a single 'user:...:legacy' bucket, so
 *   consecutive bubbles from DIFFERENT humans never clobber each other.
 */
export function getMessageSenderKey(message: MessageView): string {
  if (message.role !== 'user' || message.type !== 'message') {
    return `${message.role}:${message.agentName ?? ''}`;
  }
  const type = message.userSenderType ?? 'unknown';
  const id = message.userSenderUserId ?? message.userSenderDisplayName ?? 'legacy';
  return `user:${type}:${id}`;
}

/**
 * Group a flat message list into render groups. Boundary rules:
 *   - Consecutive ACTIVITY messages (tool calls / event triggers /
 *     agent-to-agent messages) merge into ONE 'activity' group regardless of
 *     kind, so a mixed run renders as a single cluster.
 *   - CONTENT messages (`type === 'message'`: assistant text / user messages)
 *     break an activity run and group by sender key (so an assistant text
 *     message is separate from the tools that follow it, and Alice → Bob
 *     consecutive user messages stay in separate groups).
 * Pure and node-testable — this is the single source of the grouping/boundary
 * logic used by `MessageList`.
 */
export function groupMessages(messages: MessageView[]): MessageGroup[] {
  const groups: MessageGroup[] = [];
  let currentGroup: MessageGroup | null = null;

  for (const message of messages) {
    const isActivity = isActivityMessage(message);
    const currentIsActivity = currentGroup?.kind === 'activity';

    let isSameSource: boolean;
    if (isActivity) {
      isSameSource = !!currentGroup && currentIsActivity;
    } else {
      const currentAgentName = currentGroup?.messages[0]?.agentName;
      const currentSenderKey = currentGroup ? getMessageSenderKey(currentGroup.messages[0]) : undefined;
      isSameSource =
        !!currentGroup &&
        !currentIsActivity &&
        currentGroup.role === message.role &&
        currentAgentName === message.agentName &&
        currentSenderKey === getMessageSenderKey(message);
    }

    if (!isSameSource) {
      currentGroup = {
        role: message.role,
        kind: isActivity ? 'activity' : 'content',
        messages: [message],
      };
      groups.push(currentGroup);
    } else {
      currentGroup!.messages.push(message);
    }
  }

  return groups;
}
