import React from 'react';
import Link from 'next/link';
import { Bot, User, Brain, GitBranch } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { MessageView, MessageGroup } from './MessageList';
import { MessageItem } from './MessageItem';
import { ActivityCluster } from './ActivityCluster';
import { shouldClusterActivity } from './message-clustering';
import LocalDateTime from '@/components/LocalDateTime';

type MessageGroupProps = {
  group: MessageGroup;
  agentIconUrl?: string;
  agentName?: string;
  onRewind?: (messageSK: string) => void;
  isRewindDisabled?: boolean;
  /** The session id (workerId) of the currently open chat session */
  currentSessionId?: string;
  /** True for the most recent visible group (its clusters default to open). */
  isLastGroup?: boolean;
};

export const MessageGroupComponent = React.memo(function MessageGroupComponent({
  group,
  agentIconUrl,
  agentName,
  onRewind,
  isRewindDisabled,
  currentSessionId,
  isLastGroup = false,
}: MessageGroupProps) {
  const t = useTranslations('sessions');
  const firstMessage = group.messages[0];
  const firstMessageDate = new Date(firstMessage.timestamp);
  const isChildSessionMessage = !!firstMessage.agentName;
  const childSessionId = firstMessage.childSessionId;
  const isActivityGroup = group.kind === 'activity';

  const isSameTime = (timestamp1: Date, timestamp2: Date): boolean => {
    return timestamp1.getHours() === timestamp2.getHours() && timestamp1.getMinutes() === timestamp2.getMinutes();
  };

  // Get thinking budget from assistant messages only
  const thinkingBudget =
    group.role === 'assistant' ? group.messages.find((msg) => msg.thinkingBudget)?.thinkingBudget || 0 : 0;

  const getBrainColor = (budget: number): string => {
    if (budget === 0) return 'text-gray-300 dark:text-gray-600';
    if (budget < 1000) return 'text-gray-400 dark:text-gray-500';
    if (budget < 5000) return 'text-gray-500 dark:text-gray-400';
    if (budget < 10000) return 'text-gray-600 dark:text-gray-300';
    if (budget < 20000) return 'text-gray-700 dark:text-gray-200';
    return 'text-gray-800 dark:text-gray-100';
  };

  const displayName = isChildSessionMessage
    ? firstMessage.agentName
    : group.role === 'assistant'
      ? agentName || 'Assistant'
      : (firstMessage.userSenderDisplayName ?? 'User');

  // Determine icon and styling for agent messages
  const getIcon = () => {
    if (isChildSessionMessage) {
      return (
        <div className="w-8 h-8 rounded-full flex items-center justify-center bg-blue-500">
          <GitBranch className="w-4 h-4 text-white" />
        </div>
      );
    }
    if (group.role === 'assistant' && agentIconUrl) {
      /* eslint-disable-next-line @next/next/no-img-element */
      return <img src={agentIconUrl} alt="Agent" className="w-8 h-8 rounded-full object-cover" />;
    }
    return (
      <div
        className={`w-8 h-8 rounded-full flex items-center justify-center ${
          group.role === 'assistant' ? 'bg-blue-600' : 'bg-gray-600'
        }`}
      >
        {group.role === 'assistant' ? <Bot className="w-4 h-4 text-white" /> : <User className="w-4 h-4 text-white" />}
      </div>
    );
  };

  // Activity groups (tool/event/agent runs) use a compact style; content
  // groups keep the normal spacing and optional child-session indent.
  const containerClass = isActivityGroup
    ? 'mb-2'
    : `mb-3 ${isChildSessionMessage ? 'ml-4 border-l-2 border-blue-200 dark:border-blue-800 pl-3' : ''}`;

  // Prefer the per-submission clientId as the reconciliation key for user
  // message bubbles: the optimistic bubble's `id` changes from `pending-*`
  // to the confirmed DynamoDB SK in onConfirm, and keying by `id` would
  // remount the subtree (re-running ImageViewer's pre-signed URL fetch and
  // blob seeding for nothing). The clientId is unique per submission and
  // stable across that transition. Bubbles without a clientId (history
  // reads, Slack/API senders, assistant messages) keep the id key.
  const renderItem = (message: MessageView, index: number, siblings: MessageView[]) => {
    const showTimestamp =
      index !== 0 && !isSameTime(new Date(message.timestamp), new Date(siblings[index - 1].timestamp));
    return (
      <MessageItem
        key={message.clientId ?? message.id}
        message={message}
        showTimestamp={showTimestamp}
        agentName={agentName}
        currentSessionId={currentSessionId}
        onRewind={onRewind}
        isRewindDisabled={isRewindDisabled}
      />
    );
  };

  const renderBody = () => {
    // An 'activity' group is a maximal run of consecutive tool calls / event
    // triggers / agent-to-agent messages. >= 2 renders as one mixed,
    // collapsible activity cluster with a per-kind breakdown header; a lone
    // activity message renders bare via the normal per-message renderer.
    if (isActivityGroup) {
      if (shouldClusterActivity(group)) {
        return (
          <ActivityCluster
            messages={group.messages}
            agentName={agentName}
            currentSessionId={currentSessionId}
            onRewind={onRewind}
            isRewindDisabled={isRewindDisabled}
            defaultExpanded={isLastGroup}
          />
        );
      }
      return group.messages.map((m, i) => renderItem(m, i, group.messages));
    }

    // Content group: assistant-text / user messages render as plain bubbles.
    return group.messages.map((m, i) => renderItem(m, i, group.messages));
  };

  return (
    <div className={containerClass}>
      {/* Hide the full header for activity groups (the cluster renders its own separator header) */}
      {!isActivityGroup && (
        <div className="flex items-center gap-3 mb-2">
          <div className="flex-shrink-0">{getIcon()}</div>
          <div className="font-semibold text-gray-900 dark:text-white flex items-center gap-2">
            {displayName}
            {childSessionId && (
              <Link
                href={`/sessions/${childSessionId}`}
                className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-normal"
              >
                {t('viewChildSession')}
              </Link>
            )}
          </div>
          <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center">
            <LocalDateTime timestamp={firstMessageDate} />
            {group.role === 'assistant' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="ml-2">
                    <Brain className={`w-4 h-4 ${getBrainColor(thinkingBudget)}`} />
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p>
                    {group.messages.find((msg) => msg.thinkingBudget)
                      ? `${t('thinkingBudget')}: ${thinkingBudget.toLocaleString()}`
                      : `${t('thinkingBudget')}: ${t('defaultThinkingBudget')}`}
                  </p>
                  {!group.messages.find((msg) => msg.thinkingBudget) && (
                    <p className="text-xs mt-1">{t('ultrathinkInstruction')}</p>
                  )}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      )}

      <div className="space-y-1">{renderBody()}</div>
    </div>
  );
});
