/**
 * Pure helpers for agent icon resolution, kept import-free so both the API
 * route (server) and unit tests can use them without pulling client/server
 * modules.
 */

/**
 * Map a resolved icon key to the key-based `/api/agent-icon` URL, or null when
 * the agent has no configured icon (→ the chip renders initials instead).
 */
export const agentIconUrlForKey = (iconKey: string | undefined | null): string | null =>
  iconKey ? `/api/agent-icon?key=${encodeURIComponent(iconKey)}` : null;

/** Whether a resolved icon value should render as an image (vs. initials). */
export const hasResolvedIcon = (iconUrl: string | null | undefined): iconUrl is string =>
  typeof iconUrl === 'string' && iconUrl.length > 0;
