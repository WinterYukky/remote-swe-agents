import { NextRequest, NextResponse } from 'next/server';
import { getPreferences, getSession, getCustomAgent } from '@remote-swe-agents/agent-core/lib';
import { getSession as getAuthSession } from '@/lib/auth';
import { agentIconUrlForKey } from '@/app/sessions/[workerId]/component/agent-icon-url';

export const dynamic = 'force-dynamic';

/** Cap the number of session ids resolved per request to bound the work. */
const MAX_SESSION_IDS = 50;

/**
 * Batch resolver: map each session id to the URL of that session's agent icon,
 * or null when the agent has no configured icon (so the client renders the
 * initials chip instead).
 *
 * GET /api/agent-icon/resolve?sessionIds=a,b,c
 *   → { "a": "/api/agent-icon?key=<iconKey>", "b": null, ... }
 *
 * The icon key is resolved server-side with the same fallback chain as the
 * main header icon (customAgent.iconKey ?? preferences.defaultAgentIconKey),
 * then handed back as the existing key-based `/api/agent-icon` URL — so the
 * actual image bytes are still served (and CloudFront-cached) by that route.
 * Requires authentication (in-route, since /api is excluded from the proxy
 * middleware). It only returns icon URLs the authenticated caller could
 * already obtain by opening the session, so it adds no new data exposure.
 *
 * Identity-first rule (B-diff): the purpose of these chips is to tell WHO is
 * talking to WHOM, so child sessions must stay visually distinct instead of
 * collapsing onto the parent's icon. A child session (one with a
 * parentSessionId) therefore shows an image ONLY when it explicitly selected
 * its own custom agent that differs from the parent's; otherwise it resolves to
 * null so the chip renders the per-session colored initials (each session id
 * hashes to a distinct color). This covers both an inherited customAgentId
 * (equal to the parent's) and the default-agent family (no customAgentId at
 * all) — without it, a parent and all its children would share the single
 * global default image. The default image thus appears only on root
 * (parent-less) sessions.
 */
export async function GET(request: NextRequest) {
  // Auth: /api is excluded from the proxy middleware matcher, so each route
  // must authenticate in-route (same convention as /api/push). Reject
  // unauthenticated callers before doing any DynamoDB reads / dynamic work.
  try {
    await getAuthSession();
  } catch {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const raw = request.nextUrl.searchParams.get('sessionIds') ?? '';
  const sessionIds = Array.from(
    new Set(
      raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    )
  ).slice(0, MAX_SESSION_IDS);

  const result: Record<string, string | null> = {};

  // Resolve the global default once; used when an agent has no custom icon.
  const preferences = await getPreferences().catch(() => undefined);
  const defaultIconKey = preferences?.defaultAgentIconKey;

  // Cache parent-session lookups so shared parents (the common case: many
  // children of one PM) are read at most once regardless of how many of their
  // children are being resolved in this batch. Memoise the in-flight PROMISE
  // (not just the resolved value) so concurrent children resolving in the same
  // Promise.all share a single getSession call instead of racing past the
  // cache before any of them has written it back.
  const parentCustomAgentIdCache = new Map<string, Promise<string | undefined>>();
  const parentCustomAgentId = (parentSessionId: string): Promise<string | undefined> => {
    const cached = parentCustomAgentIdCache.get(parentSessionId);
    if (cached) return cached;
    const promise = getSession(parentSessionId)
      .then((parent) => parent?.customAgentId)
      .catch(() => undefined);
    parentCustomAgentIdCache.set(parentSessionId, promise);
    return promise;
  };

  await Promise.all(
    sessionIds.map(async (sessionId) => {
      try {
        const session = await getSession(sessionId);

        // B-diff (identity-first): a child session (one with a parent) only
        // shows an image when it EXPLICITLY selected its own custom agent that
        // differs from the parent's. Everything else about a child resolves to
        // null (→ per-session colored initials) so children stay visually
        // distinct:
        //   - no customAgentId at all (default-agent family): the parent + all
        //     its children would otherwise collapse to the same global default
        //     image, destroying identity — so children get initials and only
        //     the root session keeps the default image.
        //   - customAgentId inherited from the parent (equal value): same
        //     collapse, so initials.
        // The default image therefore appears only on root (parent-less)
        // sessions; child image only when a distinct agent was chosen.
        if (session?.parentSessionId) {
          if (!session.customAgentId) {
            result[sessionId] = null;
            return;
          }
          const parentAgentId = await parentCustomAgentId(session.parentSessionId);
          if (parentAgentId && parentAgentId === session.customAgentId) {
            result[sessionId] = null;
            return;
          }
        }

        const customAgent = session?.customAgentId ? await getCustomAgent(session.customAgentId) : undefined;
        const iconKey = customAgent?.iconKey || defaultIconKey;
        result[sessionId] = agentIconUrlForKey(iconKey);
      } catch {
        result[sessionId] = null;
      }
    })
  );

  return NextResponse.json(result, {
    // Icon config rarely changes; let the browser cache the mapping briefly.
    headers: { 'Cache-Control': 'private, max-age=60' },
  });
}
