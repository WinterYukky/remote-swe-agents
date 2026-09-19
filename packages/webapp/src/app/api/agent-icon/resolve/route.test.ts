import { describe, expect, test, vi, beforeEach } from 'vitest';

// The resolve route authenticates in-route via `@/lib/auth` getSession and
// resolves icon keys via agent-core. Mock both so we can exercise the auth
// gate and the mapping without real Cognito / DynamoDB.
const mockAuth = vi.fn();
const mockGetSession = vi.fn();
const mockGetCustomAgent = vi.fn();
const mockGetPreferences = vi.fn();

vi.mock('@/lib/auth', () => ({
  getSession: (...args: any[]) => mockAuth(...args),
}));

vi.mock('@remote-swe-agents/agent-core/lib', () => ({
  getSession: (...args: any[]) => mockGetSession(...args),
  getCustomAgent: (...args: any[]) => mockGetCustomAgent(...args),
  getPreferences: (...args: any[]) => mockGetPreferences(...args),
}));

import { GET } from './route';

function buildRequest(sessionIds: string): any {
  return {
    nextUrl: { searchParams: new URLSearchParams(sessionIds ? `sessionIds=${sessionIds}` : '') },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetPreferences.mockResolvedValue({ defaultAgentIconKey: undefined });
});

describe('GET /api/agent-icon/resolve auth', () => {
  test('returns 401 for an unauthenticated caller and does no resolution', async () => {
    mockAuth.mockRejectedValue(new Error('session not found'));
    const res = await GET(buildRequest('s1,s2'));
    expect(res.status).toBe(401);
    expect(mockGetSession).not.toHaveBeenCalled();
    expect(mockGetCustomAgent).not.toHaveBeenCalled();
  });

  test('authenticated caller: resolves configured icon to a url and missing to null', async () => {
    mockAuth.mockResolvedValue({ userId: 'u1' });
    mockGetSession.mockImplementation(async (id: string) =>
      id === 's1' ? { customAgentId: 'a1' } : { customAgentId: undefined }
    );
    mockGetCustomAgent.mockImplementation(async (id: string) =>
      id === 'a1' ? { iconKey: 'icons/a1.png' } : undefined
    );
    const res = await GET(buildRequest('s1,s2'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      s1: '/api/agent-icon?key=icons%2Fa1.png',
      s2: null,
    });
  });

  test('authenticated: falls back to the global default icon when the agent has none', async () => {
    mockAuth.mockResolvedValue({ userId: 'u1' });
    mockGetPreferences.mockResolvedValue({ defaultAgentIconKey: 'icons/default.png' });
    mockGetSession.mockResolvedValue({ customAgentId: undefined });
    const res = await GET(buildRequest('s9'));
    const body = await res.json();
    expect(body).toEqual({ s9: '/api/agent-icon?key=icons%2Fdefault.png' });
  });
});

describe('GET /api/agent-icon/resolve inheritance (B-diff)', () => {
  beforeEach(() => {
    mockAuth.mockResolvedValue({ userId: 'u1' });
  });

  test('child that inherited the parent customAgentId resolves to null (initials), not the parent image', async () => {
    // child (id "child") inherited parent "p1"'s agent "a1"; both share "a1".
    mockGetSession.mockImplementation(async (id: string) => {
      if (id === 'child') return { customAgentId: 'a1', parentSessionId: 'p1' };
      if (id === 'p1') return { customAgentId: 'a1' };
      return undefined;
    });
    mockGetCustomAgent.mockResolvedValue({ iconKey: 'icons/a1.png' });
    const res = await GET(buildRequest('child'));
    const body = await res.json();
    // Inherited → initials, so no icon URL even though a1 has an iconKey.
    expect(body).toEqual({ child: null });
    // The inheritance short-circuit must skip the icon lookup entirely.
    expect(mockGetCustomAgent).not.toHaveBeenCalled();
  });

  test('child with an explicitly different customAgentId keeps its own image', async () => {
    mockGetSession.mockImplementation(async (id: string) => {
      if (id === 'child') return { customAgentId: 'a2', parentSessionId: 'p1' };
      if (id === 'p1') return { customAgentId: 'a1' };
      return undefined;
    });
    mockGetCustomAgent.mockImplementation(async (id: string) =>
      id === 'a2' ? { iconKey: 'icons/a2.png' } : { iconKey: 'icons/a1.png' }
    );
    const res = await GET(buildRequest('child'));
    const body = await res.json();
    expect(body).toEqual({ child: '/api/agent-icon?key=icons%2Fa2.png' });
  });

  test('a session with a customAgentId but no parent keeps its image (no inheritance possible)', async () => {
    mockGetSession.mockImplementation(async (id: string) => (id === 'root' ? { customAgentId: 'a1' } : undefined));
    mockGetCustomAgent.mockResolvedValue({ iconKey: 'icons/a1.png' });
    const res = await GET(buildRequest('root'));
    const body = await res.json();
    expect(body).toEqual({ root: '/api/agent-icon?key=icons%2Fa1.png' });
  });

  test('M-1: a child with no customAgentId (default-agent family) resolves to null, not the global default image', async () => {
    // Even with a global default icon configured, a parented child that never
    // picked its own agent must render initials — otherwise the parent and all
    // its default children collapse onto the same default image.
    mockGetPreferences.mockResolvedValue({ defaultAgentIconKey: 'icons/default.png' });
    mockGetSession.mockImplementation(async (id: string) =>
      id === 'child' ? { customAgentId: undefined, parentSessionId: 'p1' } : undefined
    );
    const res = await GET(buildRequest('child'));
    const body = await res.json();
    expect(body).toEqual({ child: null });
    // No customAgentId → no icon lookup, and no parent read is needed either.
    expect(mockGetCustomAgent).not.toHaveBeenCalled();
    const parentReads = mockGetSession.mock.calls.filter((c: any[]) => c[0] === 'p1').length;
    expect(parentReads).toBe(0);
  });

  test('M-1: the global default image appears only on a root (parent-less) session, not on its default children', async () => {
    mockGetPreferences.mockResolvedValue({ defaultAgentIconKey: 'icons/default.png' });
    mockGetSession.mockImplementation(async (id: string) => {
      if (id === 'root') return { customAgentId: undefined };
      if (id === 'child') return { customAgentId: undefined, parentSessionId: 'root' };
      return undefined;
    });
    const res = await GET(buildRequest('root,child'));
    const body = await res.json();
    expect(body).toEqual({
      root: '/api/agent-icon?key=icons%2Fdefault.png',
      child: null,
    });
  });

  test('parent lookup is cached: many inherited children of one parent read the parent once', async () => {
    mockGetSession.mockImplementation(async (id: string) => {
      if (id === 'p1') return { customAgentId: 'a1' };
      // c1..c3 are all inherited children of p1.
      if (id.startsWith('c')) return { customAgentId: 'a1', parentSessionId: 'p1' };
      return undefined;
    });
    mockGetCustomAgent.mockResolvedValue({ iconKey: 'icons/a1.png' });
    const res = await GET(buildRequest('c1,c2,c3'));
    const body = await res.json();
    expect(body).toEqual({ c1: null, c2: null, c3: null });
    // getSession called for c1,c2,c3 (3) + p1 exactly once (cached) = 4.
    const parentReads = mockGetSession.mock.calls.filter((c: any[]) => c[0] === 'p1').length;
    expect(parentReads).toBe(1);
  });
});
