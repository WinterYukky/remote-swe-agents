import { describe, expect, test, beforeEach, afterEach, vi } from 'vitest';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { __internal, buildKiroMcpServerList, buildRemoteSweProfileMcpServers } from './kiro-mcp-servers';
import type { CustomAgent } from '@remote-swe-agents/agent-core/schema';

// Mock only the true external (Secrets Manager fetch) so the integration
// tests can drive the REAL buildKiroMcpServerList → resolveMcpServerSecrets
// path offline. Preserve the rest of the module's exports.
vi.mock('@remote-swe-agents/agent-core/aws', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@remote-swe-agents/agent-core/aws')>();
  return { ...actual, getSecretString: vi.fn() };
});

const baseAgent: CustomAgent = {
  PK: 'agents',
  SK: 'default',
  name: 'test',
  description: '',
  defaultModel: 'opus4.7',
  systemPrompt: '',
  tools: [],
  useAllTools: true,
  mcpConfig: JSON.stringify({ mcpServers: {} }),
  runtimeType: 'ec2',
  includeDefaultKnowledge: true,
  iconKey: '',
  inferenceMode: 'bedrock',
} as unknown as CustomAgent;

describe('buildKiroMcpServerList', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    // The production default is stdio (see resolveTransport). These tests
    // exercise that path and should stay offline; explicitly delete
    // KIRO_MCP_TRANSPORT so an outer shell / CI env can't change the
    // transport under our feet.
    process.env = { ...originalEnv };
    delete process.env.KIRO_MCP_TRANSPORT;
    delete process.env.KIRO_MCP_DISABLED;
  });
  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  test('stdio transport does NOT client-send remote-swe (profile owns it)', async () => {
    // remote-swe is now declared in the base worker agent PROFILE
    // (buildRemoteSweProfileMcpServers), NOT sent as an ACP client server, so
    // KAS exposes its tools + honours waitForReady on the profile path and we
    // avoid a double spawn. With no custom-agent servers the client list is empty.
    const servers = await buildKiroMcpServerList({ workerId: 'w1', customAgent: baseAgent });
    expect(servers.find((s) => s.name === 'remote-swe')).toBeUndefined();
    expect(servers).toHaveLength(0);
  });

  test('buildRemoteSweProfileMcpServers emits the profile-owned remote-swe stdio server', () => {
    const rec = buildRemoteSweProfileMcpServers('w1') as Record<string, any>;
    expect(rec).toBeDefined();
    expect(Object.keys(rec)).toEqual(['remote-swe']);
    const s = rec['remote-swe'];
    // Same spawn form as the old client descriptor: node --import <tsx> <bin.ts>.
    expect(s.command).toBe(process.execPath);
    expect(s.command).not.toBe('npx');
    expect(s.args[0]).toBe('--import');
    expect(s.args[1]).toMatch(/tsx/);
    expect(s.args[2]).toMatch(/\/packages\/agent-core\/src\/mcp-server\/bin\.ts$/);
    // waitForReady on the PROFILE server is the ordering fix (blocks tool-selection).
    expect(s.waitForReady).toBe(true);
    // env is record-form and always carries WORKER_ID.
    expect(s.env.WORKER_ID).toBe('w1');
  });

  test('profile-env guarantee: profile env injects NON-secret config the AWS tools need', () => {
    // KAS spawns a profile server with only safe-6 + config.env (NOT the worker
    // process env), so the config the tools read must be injected here. Without
    // this, AWS-touching tools fail at runtime with "Region is missing".
    process.env.AWS_REGION = 'ap-northeast-1';
    process.env.TABLE_NAME = 'RemoteSwe-Table';
    process.env.BUCKET_NAME = 'remote-swe-bucket';
    process.env.EVENT_TRIGGER_SFN_ARN = 'arn:aws:states:ap-northeast-1:111122223333:stateMachine:et';
    // #322 TZ merge: timezone config must forward to the profile subprocess so
    // the MCP tools' time-of-day output is local time rather than UTC.
    process.env.TZ = 'Asia/Tokyo';
    process.env.AGENT_TIMEZONE = 'Asia/Tokyo';
    const rec = buildRemoteSweProfileMcpServers('w1') as Record<string, any>;
    const env = rec['remote-swe'].env as Record<string, string>;
    expect(env.AWS_REGION).toBe('ap-northeast-1');
    expect(env.TABLE_NAME).toBe('RemoteSwe-Table');
    expect(env.BUCKET_NAME).toBe('remote-swe-bucket');
    expect(env.EVENT_TRIGGER_SFN_ARN).toBe('arn:aws:states:ap-northeast-1:111122223333:stateMachine:et');
    expect(env.TZ).toBe('Asia/Tokyo');
    expect(env.AGENT_TIMEZONE).toBe('Asia/Tokyo');
    expect(env.WORKER_ID).toBe('w1');
  });

  test('profile-env guarantee: profile env NEVER contains secret values (no secret on disk)', () => {
    // Secret VALUES set in the worker env must NOT be copied into the profile
    // JSON. Credentials resolve at runtime via the HOME cred cache; Slack/GitHub
    // tokens resolve at runtime from SSM/file.
    process.env.SLACK_BOT_TOKEN = 'xoxb-should-not-leak';
    process.env.GITHUB_PERSONAL_ACCESS_TOKEN = 'ghp_should_not_leak';
    process.env.AWS_ACCESS_KEY_ID = 'AKIA_should_not_leak';
    process.env.AWS_SECRET_ACCESS_KEY = 'secret_should_not_leak';
    process.env.AWS_SESSION_TOKEN = 'session_should_not_leak';
    const rec = buildRemoteSweProfileMcpServers('w1') as Record<string, any>;
    const env = rec['remote-swe'].env as Record<string, string>;
    for (const k of Object.keys(env)) {
      expect(__internal.isSecretEnvName(k)).toBe(false);
    }
    expect(env).not.toHaveProperty('SLACK_BOT_TOKEN');
    expect(env).not.toHaveProperty('GITHUB_PERSONAL_ACCESS_TOKEN');
    expect(env).not.toHaveProperty('AWS_ACCESS_KEY_ID');
    expect(env).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
    expect(env).not.toHaveProperty('AWS_SESSION_TOKEN');
    // And no injected VALUE equals a known secret.
    for (const v of Object.values(env)) {
      expect(v).not.toContain('should_not_leak');
      expect(v).not.toContain('should-not-leak');
    }
  });

  test('profile-env guarantee: the config allowlist itself contains no secret-named key', () => {
    for (const k of __internal.PROFILE_CONFIG_ENV_ALLOWLIST) {
      expect(__internal.isSecretEnvName(k)).toBe(false);
    }
    // GITHUB_APP_PRIVATE_KEY_PATH is a path ref, explicitly allowed.
    expect(__internal.PROFILE_CONFIG_ENV_ALLOWLIST).toContain('GITHUB_APP_PRIVATE_KEY_PATH');
    // The two secret VALUE vars are NOT in the allowlist.
    expect(__internal.PROFILE_CONFIG_ENV_ALLOWLIST).not.toContain('SLACK_BOT_TOKEN');
    expect(__internal.PROFILE_CONFIG_ENV_ALLOWLIST).not.toContain('GITHUB_PERSONAL_ACCESS_TOKEN');
  });

  test('profile-env guarantee: isSecretEnvName classifies token/secret/cred keys but not the path ref', () => {
    expect(__internal.isSecretEnvName('SLACK_BOT_TOKEN')).toBe(true);
    expect(__internal.isSecretEnvName('GITHUB_PERSONAL_ACCESS_TOKEN')).toBe(true);
    expect(__internal.isSecretEnvName('AWS_SECRET_ACCESS_KEY')).toBe(true);
    expect(__internal.isSecretEnvName('AWS_SESSION_TOKEN')).toBe(true);
    expect(__internal.isSecretEnvName('DB_PASSWORD')).toBe(true);
    expect(__internal.isSecretEnvName('SOME_CREDENTIAL')).toBe(true);
    expect(__internal.isSecretEnvName('GITHUB_APP_PRIVATE_KEY_PATH')).toBe(false);
    expect(__internal.isSecretEnvName('AWS_REGION')).toBe(false);
    expect(__internal.isSecretEnvName('TABLE_NAME')).toBe(false);
  });

  test('profile-env guarantee follow-up: deny substrings also catch ACCESS_KEY / API_KEY / PASSPHRASE', () => {
    // Reviewer follow-up: guard must catch these even though they are not in the
    // current allowlist, so a future accidental allowlist addition can't leak.
    expect(__internal.isSecretEnvName('AWS_ACCESS_KEY_ID')).toBe(true);
    expect(__internal.isSecretEnvName('SOME_ACCESS_KEY')).toBe(true);
    expect(__internal.isSecretEnvName('OPENAI_API_KEY')).toBe(true);
    expect(__internal.isSecretEnvName('KIRO_API_KEY')).toBe(true);
    expect(__internal.isSecretEnvName('SSH_PASSPHRASE')).toBe(true);
    // Non-secret config still passes.
    expect(__internal.isSecretEnvName('AGENT_RUNTIME_ARN')).toBe(false);
    expect(__internal.isSecretEnvName('EVENT_TRIGGER_SFN_ARN')).toBe(false);
  });

  test('buildRemoteSweProfileMcpServers returns undefined when MCP disabled', () => {
    process.env.KIRO_MCP_DISABLED = '1';
    expect(buildRemoteSweProfileMcpServers('w1')).toBeUndefined();
  });

  test('buildRemoteSweProfileMcpServers returns undefined on http transport (secret must not be on disk)', () => {
    process.env.KIRO_MCP_TRANSPORT = 'http';
    expect(buildRemoteSweProfileMcpServers('w1')).toBeUndefined();
  });

  test('KIRO_MCP_DISABLED=1 suppresses the remote-swe server', async () => {
    process.env.KIRO_MCP_DISABLED = '1';
    const servers = await buildKiroMcpServerList({ workerId: 'w1', customAgent: baseAgent });
    expect(servers.find((s) => s.name === 'remote-swe')).toBeUndefined();
  });

  test('merges enabled custom-agent MCP servers (remote-swe is profile-owned, not in client list)', async () => {
    const agent = {
      ...baseAgent,
      mcpConfig: JSON.stringify({
        mcpServers: {
          custom: { command: '/bin/node', args: ['x.js'], env: { FOO: 'bar' } },
          disabled: { command: '/bin/node', args: ['y.js'], enabled: false },
          http: { url: 'https://example.com/mcp' },
        },
      }),
    } as CustomAgent;
    const servers = await buildKiroMcpServerList({ workerId: 'w1', customAgent: agent });
    const names = servers.map((s) => s.name);
    // remote-swe is profile-owned now, so it is NOT in the client server list.
    expect(names).not.toContain('remote-swe');
    expect(names).toContain('custom');
    expect(names).toContain('http');
    expect(names).not.toContain('disabled');
    const httpServer = servers.find((s) => s.name === 'http');
    expect(httpServer?.type).toBe('http');
    if (httpServer?.type === 'http') {
      expect(httpServer.url).toBe('https://example.com/mcp');
    }
    const customServer = servers.find((s) => s.name === 'custom');
    if (customServer?.type === 'stdio') {
      const foo = customServer.env.find((e) => e.name === 'FOO');
      expect(foo?.value).toBe('bar');
    }
  });

  test('invalid mcpConfig JSON silently degrades (no throw; empty client list, remote-swe is profile-owned)', async () => {
    const agent = { ...baseAgent, mcpConfig: '{not valid json' } as CustomAgent;
    const servers = await buildKiroMcpServerList({ workerId: 'w1', customAgent: agent });
    // remote-swe is profile-owned (not client-sent) on stdio; invalid custom
    // config degrades to an empty client list without throwing.
    expect(servers.map((s) => s.name)).toEqual([]);
  });

  test('envRecordToAcpArray converts undefined to empty array', () => {
    expect(__internal.envRecordToAcpArray(undefined)).toEqual([]);
    expect(__internal.envRecordToAcpArray({ A: '1', B: '2' })).toEqual([
      { name: 'A', value: '1' },
      { name: 'B', value: '2' },
    ]);
  });

  test('buildKiroMcpServerList actually invokes resolveMcpServerSecrets (secret placeholder is resolved)', async () => {
    // Regression guard: if the resolveMcpServerSecrets wiring is removed from
    // buildKiroMcpServerList, the ${secret:...} placeholder would pass through
    // unresolved and this assertion fails. We mock the secrets-manager fetch
    // (the only true external) and drive the REAL buildKiroMcpServerList →
    // parseCustomAgentMcpConfig → resolveMcpServerSecrets path.
    const { getSecretString } = await import('@remote-swe-agents/agent-core/aws');
    const fetchSpy = vi.mocked(getSecretString).mockResolvedValue('resolved-token');
    const agent = {
      ...baseAgent,
      mcpConfig: JSON.stringify({
        mcpServers: {
          custom: { command: '/bin/node', args: ['x.js'], env: { API_TOKEN: '${secret:my-token}' } },
        },
      }),
    } as CustomAgent;
    const servers = await buildKiroMcpServerList({ workerId: 'w1', customAgent: agent });
    const custom = servers.find((s) => s.name === 'custom');
    expect(custom?.type).toBe('stdio');
    if (custom?.type === 'stdio') {
      const token = custom.env.find((e) => e.name === 'API_TOKEN');
      expect(token?.value).toBe('resolved-token');
    }
    expect(fetchSpy).toHaveBeenCalledWith('remote-swe/mcp-secrets/my-token');
  });

  test('resolveMcpServerSecrets wiring runs on the KIRO_MCP_DISABLED path too', async () => {
    process.env.KIRO_MCP_DISABLED = '1';
    const { getSecretString } = await import('@remote-swe-agents/agent-core/aws');
    const fetchSpy = vi.mocked(getSecretString).mockResolvedValue('disabled-path-token');
    const agent = {
      ...baseAgent,
      mcpConfig: JSON.stringify({
        mcpServers: {
          custom: { command: '/bin/node', args: ['x.js'], env: { API_TOKEN: '${secret:my-token}' } },
        },
      }),
    } as CustomAgent;
    const servers = await buildKiroMcpServerList({ workerId: 'w1', customAgent: agent });
    const custom = servers.find((s) => s.name === 'custom');
    if (custom?.type === 'stdio') {
      expect(custom.env.find((e) => e.name === 'API_TOKEN')?.value).toBe('disabled-path-token');
    }
    expect(fetchSpy).toHaveBeenCalledWith('remote-swe/mcp-secrets/my-token');
  });

  test('fingerprintMcpServers is deterministic and order-sensitive', () => {
    const a = [
      { type: 'stdio' as const, name: 'x', command: 'c', args: [], env: [] },
      { type: 'stdio' as const, name: 'y', command: 'c', args: [], env: [] },
    ];
    const b = [a[1]!, a[0]!];
    expect(__internal.fingerprintMcpServers(a)).toBe(__internal.fingerprintMcpServers(a));
    expect(__internal.fingerprintMcpServers(a)).not.toBe(__internal.fingerprintMcpServers(b));
  });
});

describe('buildKiroMcpServerList (http transport, opt-in via KIRO_MCP_TRANSPORT=http)', () => {
  const originalEnv = { ...process.env };
  beforeEach(() => {
    process.env = { ...originalEnv, KIRO_MCP_TRANSPORT: 'http' };
    delete process.env.KIRO_MCP_DISABLED;
  });
  afterEach(async () => {
    // Ensure the singleton HTTP server is shut down between tests so
    // each case gets its own ephemeral port + secret.
    const { stopKiroMcpHttpServer } = await import('./kiro-mcp-http');
    await stopKiroMcpHttpServer();
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  test('KIRO_MCP_TRANSPORT=http emits an http descriptor with Bearer auth', async () => {
    const servers = await buildKiroMcpServerList({ workerId: 'w1', customAgent: baseAgent });
    expect(servers).toHaveLength(1);
    const s = servers[0]!;
    expect(s.type).toBe('http');
    expect(s.name).toBe('remote-swe');
    if (s.type === 'http') {
      expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      const auth = s.headers.find((h) => h.name === 'Authorization');
      expect(auth?.value).toMatch(/^Bearer [a-f0-9]{48}$/);
    }
  });

  test('second invocation reuses the cached HTTP server (same url+secret)', async () => {
    const first = await buildKiroMcpServerList({ workerId: 'w1', customAgent: baseAgent });
    const second = await buildKiroMcpServerList({ workerId: 'w1', customAgent: baseAgent });
    const f = first[0]!;
    const s = second[0]!;
    if (f.type !== 'http' || s.type !== 'http') throw new Error('expected http');
    expect(s.url).toBe(f.url);
    const authF = f.headers.find((h) => h.name === 'Authorization')!;
    const authS = s.headers.find((h) => h.name === 'Authorization')!;
    expect(authS.value).toBe(authF.value);
  });
});

describe('resolveRemoteSweMcpBin (production-equivalence: build-independent)', () => {
  // This is a hot path: kiro-cli spawns the remote-swe MCP server from the
  // path returned here. A regression means "the agent cannot use tools".
  // We pin that the resolved path is agent-core's source `mcp-server/bin.ts`
  // and, crucially, that it resolves identically whether or not agent-core
  // has been compiled to `dist/` (dev/test vs production-equivalent build).
  const require = createRequire(import.meta.url);
  const agentCoreRoot = path.dirname(require.resolve('@remote-swe-agents/agent-core/package.json'));
  const distDir = path.join(agentCoreRoot, 'dist');
  const expectedBin = path.join(agentCoreRoot, 'src', 'mcp-server', 'bin.ts');
  // Track whether a real build already produced dist so we never delete it.
  let createdFakeDist = false;

  afterEach(() => {
    if (createdFakeDist) {
      fs.rmSync(distDir, { recursive: true, force: true });
      createdFakeDist = false;
    }
  });

  test('returns `<node> --import <tsx> <agent-core>/src/mcp-server/bin.ts` (file exists)', () => {
    const { command, args } = __internal.resolveRemoteSweMcpBin();
    expect(command).toBe(process.execPath);
    expect(args[0]).toBe('--import');
    expect(args[1]).toMatch(/tsx/);
    expect(args[2]).toBe(expectedBin);
    expect(args[2]).toMatch(/\/packages\/agent-core\/src\/mcp-server\/bin\.ts$/);
    expect(fs.existsSync(args[2]!)).toBe(true);
  });

  test('does NOT use npx (the MCP-exposure fix connect-flake regression guard)', () => {
    // npx re-resolves the tsx bin on every spawn and adds an extra Node
    // process layer, inflating the stdio MCP subprocess cold-start latency and
    // variance. That is what raced KAS's connect deadline and silently dropped
    // the remote-swe tools for a turn. Guard that we never regress to npx.
    const { command, args } = __internal.resolveRemoteSweMcpBin();
    expect(command).not.toBe('npx');
    expect(args).not.toContain('npx');
    // The tsx loader must be an absolute path so the spawn is CWD-independent.
    expect(path.isAbsolute(args[1]!)).toBe(true);
  });

  test('resolves to the SAME src bin path with dist absent (dev/test)', () => {
    // Only assert the dist-absent branch when dist genuinely does not exist,
    // so we never clobber a real build that another test/run produced.
    if (fs.existsSync(distDir)) return;
    const { args } = __internal.resolveRemoteSweMcpBin();
    expect(args[2]).toBe(expectedBin);
  });

  test('resolves to the SAME src bin path with dist present (production-equivalent)', () => {
    const distAlreadyExists = fs.existsSync(distDir);
    if (!distAlreadyExists) {
      // Simulate a production build: agent-core compiled to dist/. The
      // resolver must NOT start pointing at dist — it must still hand kiro-cli
      // the source bin.ts so the worker's tsx runtime can spawn it.
      fs.mkdirSync(path.join(distDir, 'mcp-server'), { recursive: true });
      fs.writeFileSync(path.join(distDir, 'mcp-server', 'index.js'), 'export {};\n');
      fs.writeFileSync(path.join(distDir, 'mcp-server', 'bin.js'), 'export {};\n');
      createdFakeDist = true;
    }
    const { command, args } = __internal.resolveRemoteSweMcpBin();
    expect(command).toBe(process.execPath);
    expect(args[0]).toBe('--import');
    expect(args[2]).toBe(expectedBin);
    expect(fs.existsSync(args[2]!)).toBe(true);
  });
});
