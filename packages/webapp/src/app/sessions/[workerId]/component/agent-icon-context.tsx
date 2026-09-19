'use client';

import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Resolves per-agent icon URLs by session id and caches them, so every avatar
 * chip in the message list can show the configured image (unified rule: any
 * agent with a configured icon shows the image on ALL chips -- from/to,
 * third-party, participants -- else the initials chip).
 *
 * A single batch request per distinct id-set resolves all needed session ids
 * via `/api/agent-icon/resolve`; results are cached in a ref so re-renders and
 * repeated rows never refetch the same id. `undefined` = not resolved yet
 * (render initials until known), `null` = resolved to "no icon" (initials),
 * string = the icon URL (render the image).
 */
type IconMap = Record<string, string | null>;

const AgentIconContext = createContext<(sessionId: string | undefined) => string | null | undefined>(() => undefined);

export const AgentIconProvider = ({ sessionIds, children }: { sessionIds: string[]; children: React.ReactNode }) => {
  const [resolved, setResolved] = useState<IconMap>({});
  // Every id we have already requested (resolved or in flight), so a given id
  // is only ever fetched once.
  const requestedRef = useRef<Set<string>>(new Set());

  // Stable, de-duplicated key of the requested id set.
  const idKey = useMemo(
    () =>
      Array.from(new Set(sessionIds.filter(Boolean)))
        .sort()
        .join(','),
    [sessionIds]
  );

  useEffect(() => {
    const ids = idKey ? idKey.split(',') : [];
    const missing = ids.filter((id) => !requestedRef.current.has(id));
    if (missing.length === 0) return;
    missing.forEach((id) => requestedRef.current.add(id));

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/agent-icon/resolve?sessionIds=${encodeURIComponent(missing.join(','))}`);
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as IconMap;
        if (cancelled) return;
        setResolved((prev) => ({ ...prev, ...data }));
      } catch {
        // On failure leave the ids unresolved -> chips fall back to initials.
        // Forget we requested them so a later render can retry.
        if (!cancelled) missing.forEach((id) => requestedRef.current.delete(id));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [idKey]);

  const getIcon = useMemo(
    () => (sessionId: string | undefined) => (sessionId ? resolved[sessionId] : undefined),
    [resolved]
  );

  return <AgentIconContext.Provider value={getIcon}>{children}</AgentIconContext.Provider>;
};

/** Returns the resolved icon URL for an agent session id, or null/undefined. */
export const useAgentIconUrl = (sessionId: string | undefined): string | null | undefined => {
  const getIcon = useContext(AgentIconContext);
  return getIcon(sessionId);
};
