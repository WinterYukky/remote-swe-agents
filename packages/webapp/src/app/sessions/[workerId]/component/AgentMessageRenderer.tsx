import React, { useState } from 'react';
import { ArrowRight, ArrowLeft, ChevronRight, ChevronDown } from 'lucide-react';
import { MessageView } from './MessageList';
import { MarkdownRenderer } from './MarkdownRenderer';
import { AgentAvatar } from './agent-avatar';
import { useAgentIconUrl } from './agent-icon-context';

type AgentMessageRendererProps = {
  message: MessageView;
  /** The agent name of the currently open chat session */
  agentName?: string;
  /** The session id (workerId) of the currently open chat session */
  currentSessionId?: string;
};

/**
 * Renders an agent-to-agent message with compact communication log style.
 *
 * A conversation always has two sides, so both the sender and the target are
 * shown as avatars (single-source identity colors via `AgentAvatar`), with an
 * arrow between them.
 *
 * Arrow direction indicates send/receive relative to the current session's
 * agent, decided by SESSION ID (not display name, which can collide across
 * agents):
 * - Current agent is the target (receiving): Sender → CurrentAgent, arrow ←
 * - Current agent is the sender (sending):   CurrentAgent → Target, arrow →
 * - Neither side is the current agent (e.g. a parent observing two other
 *   agents): Sender → Target, arrow →
 * When session ids are missing (legacy data) we fall back to name matching.
 */
export const AgentMessageRenderer = ({ message, agentName, currentSessionId }: AgentMessageRendererProps) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const isAck = message.isAcknowledge;

  const senderName = message.senderAgentName || 'Agent';
  const targetName = message.targetAgentName;

  // Identify the current session PER SIDE: when that side carries a session
  // id, match on it (collision-free); only when the side's session id is
  // absent (legacy data) fall back to display-name matching. Keying on
  // `currentSessionId` presence instead would make the name fallback
  // unreachable, since currentSessionId is essentially always provided.
  const isCurrentSender = message.senderSessionId
    ? message.senderSessionId === currentSessionId
    : !!agentName && message.senderAgentName === agentName;
  const isCurrentTarget = message.targetSessionId
    ? message.targetSessionId === currentSessionId
    : !!agentName && message.targetAgentName === agentName;

  // Always present the conversation as from → to. When the current session is
  // the receiver we render the arrow reversed (←) so the current agent reads
  // on the right, matching the previous receive semantics.
  const receiving = isCurrentTarget && !isCurrentSender;

  const fromSession = receiving ? message.targetSessionId : message.senderSessionId;
  const fromName = receiving ? targetName || agentName : senderName;
  const toSession = receiving ? message.senderSessionId : message.targetSessionId;
  const toName = receiving ? senderName : targetName;

  const ArrowIcon = receiving ? ArrowLeft : ArrowRight;

  const fromIcon = useAgentIconUrl(fromSession);
  const toIcon = useAgentIconUrl(toSession);

  return (
    <div className="rounded-md min-w-0 w-full overflow-hidden">
      <div className="flex items-start gap-2 min-w-0">
        <button onClick={() => setIsExpanded(!isExpanded)} className="flex-shrink-0 mt-0.5 cursor-pointer">
          {isExpanded ? (
            <ChevronDown className="w-4 h-4 text-gray-400" />
          ) : (
            <ChevronRight className="w-4 h-4 text-gray-400" />
          )}
        </button>
        <div
          role="button"
          tabIndex={0}
          onClick={() => setIsExpanded(!isExpanded)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              setIsExpanded(!isExpanded);
            }
          }}
          className="flex-1 flex items-center text-left text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 cursor-pointer min-w-0 gap-2"
        >
          <AgentAvatar sessionId={fromSession} name={fromName} iconUrl={fromIcon} sizeClassName="w-5 h-5" />
          <span className="font-medium text-sm truncate">{fromName || 'Agent'}</span>
          {toName || toSession ? (
            <>
              <ArrowIcon className="w-3.5 h-3.5 flex-shrink-0" />
              <AgentAvatar sessionId={toSession} name={toName} iconUrl={toIcon} sizeClassName="w-5 h-5" />
              <span className="font-medium text-sm truncate">{toName || 'Agent'}</span>
              {isAck && <span className="text-xs text-green-600 dark:text-green-400 flex-shrink-0">(ack)</span>}
            </>
          ) : (
            <span className="text-sm text-gray-500 truncate">
              {message.content.length > 60 ? message.content.slice(0, 60) + '...' : message.content}
            </span>
          )}
        </div>
      </div>
      {isExpanded && (
        <div className="ml-6 mt-2 p-3 rounded-md bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 overflow-x-auto max-w-full">
          <div className="text-sm text-gray-700 dark:text-gray-300 [&_pre]:overflow-x-auto [&_pre]:max-w-full [&_code]:break-all">
            <MarkdownRenderer content={message.content} />
          </div>
        </div>
      )}
    </div>
  );
};
