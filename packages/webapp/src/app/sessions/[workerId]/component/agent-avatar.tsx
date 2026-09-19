import React from 'react';
import { useAgentIconUrl } from './agent-icon-context';
import { hasResolvedIcon } from './agent-icon-url';

/**
 * Single source of truth for agent identity colors.
 *
 * Every place that visually represents an agent (the agent-conversation
 * cluster header avatars and the from/to avatars in `AgentMessageRenderer`)
 * derives its color from `agentColorClasses` so the SAME agent always gets
 * the SAME color across the whole UI.
 *
 * The color is keyed on the agent's `sessionId` when available (stable and
 * collision-free even when two agents share a display name), falling back to
 * the display name only for legacy data that predates session ids.
 *
 * Each palette entry carries an explicit light AND dark background so the
 * white foreground text stays readable in both themes.
 */
type AvatarColor = { bg: string; text: string };

const AVATAR_PALETTE: AvatarColor[] = [
  // Deep hues: white on the -400 dark variant still contrasts well.
  { bg: 'bg-purple-500 dark:bg-purple-400', text: 'text-white' },
  { bg: 'bg-rose-500 dark:bg-rose-400', text: 'text-white' },
  { bg: 'bg-indigo-500 dark:bg-indigo-400', text: 'text-white' },
  { bg: 'bg-fuchsia-500 dark:bg-fuchsia-400', text: 'text-white' },
  { bg: 'bg-blue-500 dark:bg-blue-400', text: 'text-white' },
  { bg: 'bg-orange-500 dark:bg-orange-500', text: 'text-white' },
  // Light hues: -400 + white is too low-contrast (~1.7:1), so keep the
  // darker -500 in dark mode too, where white stays readable.
  { bg: 'bg-sky-500 dark:bg-sky-500', text: 'text-white' },
  { bg: 'bg-amber-500 dark:bg-amber-500', text: 'text-white' },
  { bg: 'bg-emerald-500 dark:bg-emerald-500', text: 'text-white' },
  { bg: 'bg-teal-500 dark:bg-teal-500', text: 'text-white' },
  { bg: 'bg-cyan-500 dark:bg-cyan-500', text: 'text-white' },
];

/** Stable string hash (djb2-ish, matches the previous cluster-header hash). */
const hashString = (value: string): number => {
  let h = 0;
  for (let i = 0; i < value.length; i++) h = (h * 31 + value.charCodeAt(i)) >>> 0;
  return h;
};

/**
 * Deterministic palette entry for an agent. Prefers `sessionId` (stable,
 * collision-free), falling back to `name` for legacy items without a session
 * id, then to a neutral bucket.
 */
export const agentColorClasses = (sessionId: string | undefined, name: string | undefined): AvatarColor => {
  const key = sessionId || name || 'agent';
  return AVATAR_PALETTE[hashString(key) % AVATAR_PALETTE.length];
};

/** 1-2 letter initials for the avatar chip, derived from the display name. */
export const agentInitials = (name: string | undefined): string => {
  const n = (name || 'Agent').trim() || 'Agent';
  const words = n.split(/[\s_-]+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toUpperCase();
  }
  // Single word (or none): use its first two letters.
  return (words[0] ?? n).slice(0, 2).toUpperCase();
};

type AgentAvatarProps = {
  /** Agent session id -- the primary color key (collision-free). */
  sessionId?: string;
  /** Display name -- used for initials and as a color fallback. */
  name?: string;
  /**
   * When set, the chip shows this image (round, cover) instead of the
   * initials+color. Any agent with a configured icon uses it on every chip.
   */
  iconUrl?: string | null;
  /** Tailwind size classes (w-*&#47;h-*). Default: w-5 h-5. */
  sizeClassName?: string;
  /** Font-size class for the initials. Default: text-[9px]. */
  textClassName?: string;
  /** Extra classes (e.g. ring / negative margin for overlapping stacks). */
  className?: string;
};

/**
 * A circular agent avatar chip: deterministic identity color (single source
 * of truth) + initials. Used for both the cluster-header participant stack
 * and the from/to avatars in agent messages so an agent looks identical
 * everywhere.
 */
export const AgentAvatar = ({
  sessionId,
  name,
  iconUrl,
  sizeClassName = 'w-5 h-5',
  textClassName = 'text-[9px]',
  className = '',
}: AgentAvatarProps) => {
  if (hasResolvedIcon(iconUrl)) {
    return (
      /* eslint-disable-next-line @next/next/no-img-element -- dynamic per-agent
         icon URL; next/image's loader/allow-list does not apply. */
      <img
        src={iconUrl}
        alt=""
        title={name || 'Agent'}
        className={`${sizeClassName} rounded-full object-cover flex-shrink-0 ${className}`}
      />
    );
  }
  const color = agentColorClasses(sessionId, name);
  return (
    <span
      className={`${sizeClassName} ${color.bg} ${color.text} ${textClassName} rounded-full flex items-center justify-center font-bold flex-shrink-0 ${className}`}
      title={name || 'Agent'}
    >
      {agentInitials(name)}
    </span>
  );
};

/**
 * An `AgentAvatar` that resolves its icon from the shared icon resolver by
 * session id. Use inside a `.map()` (where a hook cannot be called directly)
 * so each participant chip can independently show its configured image or
 * fall back to initials.
 */
export const ParticipantAvatar = ({
  sessionId,
  name,
  className = '',
}: {
  sessionId?: string;
  name?: string;
  className?: string;
}) => {
  const iconUrl = useAgentIconUrl(sessionId);
  return <AgentAvatar sessionId={sessionId} name={name} iconUrl={iconUrl} className={className} />;
};
