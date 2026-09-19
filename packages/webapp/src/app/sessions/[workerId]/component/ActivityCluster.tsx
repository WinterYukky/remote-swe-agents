import React from 'react';
import { ChevronRight, ChevronDown, Wrench, Zap, MessagesSquare } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { prettifyToolName } from '@remote-swe-agents/agent-core/tool-name-utils';
import { MessageView } from './MessageList';
import { MessageItem } from './MessageItem';
import { useClusterVisibility } from './use-cluster-visibility';
import { ParticipantAvatar } from './agent-avatar';
import { activityBreakdown, isToolClusterRunning, runningToolName } from './message-clustering';

type ActivityClusterProps = {
  messages: MessageView[];
  agentName?: string;
  /** The session id (workerId) of the currently open chat session */
  currentSessionId?: string;
  onRewind?: (messageSK: string) => void;
  isRewindDisabled?: boolean;
  /** Default expanded state (latest cluster open, older collapsed). */
  defaultExpanded?: boolean;
};

type Participant = { sessionId?: string; name: string };

/**
 * Collect unique conversation participants from BOTH sides (sender AND
 * target) of every agent-to-agent message in the run. A conversation has two
 * ends, so the receiving/parent side must appear too. Deduped by session id
 * when present, else by name; first-seen order.
 */
const collectParticipants = (messages: MessageView[]): Participant[] => {
  const result: Participant[] = [];
  const seen = new Set<string>();
  const add = (sessionId: string | undefined, name: string | undefined) => {
    if (!sessionId && !name) return;
    const key = sessionId || `name:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    result.push({ sessionId, name: name || 'Agent' });
  };
  for (const m of messages) {
    if (m.type !== 'agentMessage') continue;
    add(m.senderSessionId, m.senderAgentName);
    add(m.targetSessionId, m.targetAgentName);
  }
  return result;
};

/**
 * A collapsible cluster for a maximal run of consecutive activity messages
 * (tool calls, event triggers, agent-to-agent messages), possibly MIXED.
 *
 * Header (flat "─ … ─" separator, tap to toggle the whole run):
 *   ▸  [participant avatars]  <breakdown chips>
 * Each present kind is one chip: ICON + count + short word. To guarantee the
 * header never overflows or wraps on mobile (375px), the WORD is revealed only
 * at >= sm (`hidden sm:inline`); narrow screens collapse to icon + number
 * only, which stays on one line no matter how many kinds are present. The
 * full, screen-reader-friendly label ("3 agent messages · 7 tools · 1 events")
 * is exposed via the button's `aria-label`; the visual chips are aria-hidden.
 *
 * When the run is still executing (a tool without output) the cluster shows a
 * running dot and, while the user has not toggled, defaults to open and
 * auto-folds when the last output arrives (via `useClusterVisibility`).
 *
 * Expanded body renders the run in timeline order; each message goes through
 * `MessageItem`, which dispatches toolUse → ToolUseRenderer (lazy
 * images preserved), eventTrigger → EventTriggerRenderer, agentMessage →
 * AgentMessageRenderer (from/to avatars). Children mount once and stay
 * mounted (hidden via CSS) so anchors / lazy caches survive a collapse.
 */
export const ActivityCluster = ({
  messages,
  agentName,
  currentSessionId,
  onRewind,
  isRewindDisabled,
  defaultExpanded = false,
}: ActivityClusterProps) => {
  const t = useTranslations('sessions');
  const running = isToolClusterRunning(messages);
  const { visible, everVisible, expanded, toggle } = useClusterVisibility(messages, { running, defaultExpanded });

  const breakdown = activityBreakdown(messages);

  type Chip = { key: string; icon: React.ReactNode; word: string; count: number; full: string };
  const chips: Chip[] = [];
  if (breakdown.agents > 0) {
    chips.push({
      key: 'agents',
      icon: <MessagesSquare className="w-3.5 h-3.5 flex-shrink-0" aria-hidden />,
      word: t('activityChatsWord'),
      count: breakdown.agents,
      full: t('activityChatsFull', { count: breakdown.agents }),
    });
  }
  if (breakdown.tools > 0) {
    chips.push({
      key: 'tools',
      icon: <Wrench className="w-3.5 h-3.5 flex-shrink-0" aria-hidden />,
      word: t('activityToolsWord'),
      count: breakdown.tools,
      full: t('activityToolsFull', { count: breakdown.tools }),
    });
  }
  if (breakdown.events > 0) {
    chips.push({
      key: 'events',
      icon: <Zap className="w-3.5 h-3.5 flex-shrink-0" aria-hidden />,
      word: t('activityEventsWord'),
      count: breakdown.events,
      full: t('activityEventsFull', { count: breakdown.events }),
    });
  }

  const participants = collectParticipants(messages);
  const runningName = running ? prettifyToolName(runningToolName(messages) ?? '') : '';
  const ariaLabel =
    chips.map((c) => c.full).join(' · ') +
    (running && runningName ? ` · ${t('activityRunningLabel', { tool: runningName })}` : '');

  return (
    <div className="my-1">
      <button
        onClick={toggle}
        aria-label={ariaLabel}
        aria-expanded={expanded}
        className="w-full flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 py-1 min-w-0"
      >
        {visible ? (
          <ChevronDown className="w-3.5 h-3.5 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" />
        )}
        <span className="flex-1 h-px bg-gray-200 dark:bg-gray-700 min-w-[8px]" />
        <span className="flex items-center gap-2 whitespace-nowrap flex-shrink-0" aria-hidden>
          {running && (
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse inline-block flex-shrink-0" />
          )}
          {participants.length > 0 && (
            <span className="flex items-center">
              {participants.slice(0, 5).map((p, i) => (
                <ParticipantAvatar
                  key={p.sessionId || p.name}
                  sessionId={p.sessionId}
                  name={p.name}
                  className={`ring-2 ring-white dark:ring-gray-900 ${i === 0 ? '' : '-ml-2'}`}
                />
              ))}
            </span>
          )}
          <span className="flex items-center gap-1.5">
            {chips.map((chip, i) => (
              <React.Fragment key={chip.key}>
                {i > 0 && <span className="text-gray-300 dark:text-gray-600">·</span>}
                <span className="flex items-center gap-1">
                  {chip.icon}
                  <span className="hidden sm:inline">{chip.word}</span>
                  <span>{chip.count}</span>
                </span>
              </React.Fragment>
            ))}
            {running && runningName && <span className="hidden sm:inline text-gray-400">· {runningName}…</span>}
          </span>
        </span>
        <span className="flex-1 h-px bg-gray-200 dark:bg-gray-700 min-w-[8px]" />
      </button>

      {everVisible && (
        <div className={`space-y-1 mt-1 ${visible ? '' : 'hidden'}`}>
          {messages.map((message) => (
            <MessageItem
              key={message.clientId ?? message.id}
              message={message}
              showTimestamp={false}
              agentName={agentName}
              currentSessionId={currentSessionId}
              onRewind={onRewind}
              isRewindDisabled={isRewindDisabled}
            />
          ))}
        </div>
      )}
    </div>
  );
};
