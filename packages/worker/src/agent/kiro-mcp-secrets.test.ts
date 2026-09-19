import { describe, expect, test, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { resolveMcpServerSecrets, __internal } from './kiro-mcp-secrets';
import type { KiroAcpMcpServer } from '@remote-swe-agents/agent-core/lib';

const stdioServer = (env: Record<string, string>, args: string[] = []): KiroAcpMcpServer => ({
  type: 'stdio',
  name: 'test-server',
  command: 'node',
  args,
  env: Object.entries(env).map(([name, value]) => ({ name, value })),
});

describe('resolveMcpServerSecrets', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(__internal.secretFileDir(), { recursive: true, force: true });
  });

  test('passes servers through untouched and never fetches when no placeholders exist', async () => {
    const fetchSecret = vi.fn();
    const servers = [stdioServer({ FOO: 'bar' }, ['--flag'])];
    const resolved = await resolveMcpServerSecrets(servers, fetchSecret);
    expect(resolved).toEqual(servers);
    expect(fetchSecret).not.toHaveBeenCalled();
  });

  test('substitutes ${secret:NAME} in env values and args with the prefixed secret', async () => {
    const fetchSecret = vi.fn().mockResolvedValue('s3cr3t');
    const servers = [stdioServer({ API_TOKEN: '${secret:my-token}' }, ['--token=${secret:my-token}'])];
    const resolved = await resolveMcpServerSecrets(servers, fetchSecret);
    expect(resolved).toHaveLength(1);
    const s = resolved[0] as Extract<KiroAcpMcpServer, { type: 'stdio' }>;
    expect(s.env).toEqual([{ name: 'API_TOKEN', value: 's3cr3t' }]);
    expect(s.args).toEqual(['--token=s3cr3t']);
    expect(fetchSecret).toHaveBeenCalledWith('remote-swe/mcp-secrets/my-token');
    // cache: two placeholders, one fetch
    expect(fetchSecret).toHaveBeenCalledTimes(1);
  });

  test('materialises ${secretFile:NAME} to a 0600 file and substitutes its path', async () => {
    const fetchSecret = vi.fn().mockResolvedValue('{"refresh_token":"x"}');
    const servers = [stdioServer({ TOKEN_PATH: '${secretFile:google-token}' })];
    const resolved = await resolveMcpServerSecrets(servers, fetchSecret);
    const s = resolved[0] as Extract<KiroAcpMcpServer, { type: 'stdio' }>;
    const filePath = s.env[0]!.value;
    expect(filePath).toMatch(/google-token$/);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('{"refresh_token":"x"}');
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  test('passes an http server through untouched when its url has no placeholder', async () => {
    const fetchSecret = vi.fn();
    const servers: KiroAcpMcpServer[] = [
      {
        type: 'http',
        name: 'h',
        url: 'https://example.com/mcp',
        headers: [{ name: 'X-Static', value: 'static' }],
      },
    ];
    const resolved = await resolveMcpServerSecrets(servers, fetchSecret);
    expect(resolved).toEqual(servers);
    expect(fetchSecret).not.toHaveBeenCalled();
  });

  test('drops an http server whose url contains a secret placeholder (never inject secret into url)', async () => {
    const fetchSecret = vi.fn().mockResolvedValue('s3cr3t');
    const servers: KiroAcpMcpServer[] = [
      { type: 'http', name: 'bad', url: 'https://example.com/${secret:api}/mcp', headers: [] },
      { type: 'http', name: 'ok', url: 'https://example.com/mcp', headers: [] },
    ];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const resolved = await resolveMcpServerSecrets(servers, fetchSecret);
    expect(resolved.map((s) => s.name)).toEqual(['ok']);
    // The secret is never fetched for a url placeholder — it is a hard drop.
    expect(fetchSecret).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  test('Critical-1 (regex lastIndex poisoning): http url drop must NOT skip placeholders in a LATER stdio server', async () => {
    // Regression for the shared /g regex bug: hasPlaceholder(server.url) ran
    // PLACEHOLDER_PATTERN.test() (global) on the http url, leaving lastIndex
    // mid-string; String.matchAll then copied that lastIndex and skipped the
    // earlier ${secret:...} in the SUBSEQUENT stdio server, letting an
    // UNRESOLVED literal reach the spawned subprocess env. The http url here is
    // long so its match ends at a high offset (> the offset of the placeholder
    // in the following stdio env value), which is what triggered the skip.
    const fetchSecret = vi.fn().mockResolvedValue('RESOLVED');
    const servers: KiroAcpMcpServer[] = [
      {
        type: 'http',
        name: 'http-with-placeholder',
        url: 'https://very-long-host.example.com/some/deep/path/segment/${secret:api}/mcp/endpoint',
        headers: [],
      },
      {
        type: 'stdio',
        name: 'later-stdio',
        command: 'node',
        args: [],
        env: [{ name: 'TOKEN', value: '${secret:tok}' }],
      },
    ];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const resolved = await resolveMcpServerSecrets(servers, fetchSecret);
    // The http server is dropped; the stdio server survives WITH the secret
    // fully resolved (no unresolved literal passthrough).
    expect(resolved.map((s) => s.name)).toEqual(['later-stdio']);
    const stdio = resolved[0] as Extract<KiroAcpMcpServer, { type: 'stdio' }>;
    expect(stdio.env).toEqual([{ name: 'TOKEN', value: 'RESOLVED' }]);
    // Assert no unresolved placeholder literal survived anywhere.
    expect(stdio.env[0]!.value).not.toContain('${secret:');
    expect(fetchSecret).toHaveBeenCalledWith('remote-swe/mcp-secrets/tok');
    expect(errorSpy).toHaveBeenCalled(); // the http drop
  });

  test('Critical-1: hasPlaceholder does not mutate shared state across repeated calls', async () => {
    // Two placeholder-bearing values processed back-to-back must both resolve;
    // a stateful (global-regex) hasPlaceholder would make the second scan start
    // mid-string.
    const fetchSecret = vi.fn().mockResolvedValue('V');
    const servers: KiroAcpMcpServer[] = [
      { type: 'http', name: 'h1', url: 'https://a/${secret:x}', headers: [] },
      { type: 'http', name: 'h2', url: 'https://b/${secret:y}', headers: [] },
      { type: 'stdio', name: 's', command: 'node', args: ['${secret:z}'], env: [] },
    ];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const resolved = await resolveMcpServerSecrets(servers, fetchSecret);
    // Both http servers dropped (url placeholders), stdio arg fully resolved.
    expect(resolved.map((s) => s.name)).toEqual(['s']);
    const s = resolved[0] as Extract<KiroAcpMcpServer, { type: 'stdio' }>;
    expect(s.args).toEqual(['V']);
    expect(errorSpy).toHaveBeenCalled();
  });

  test('resolves a ${secret:} placeholder in a stdio command', async () => {
    const fetchSecret = vi.fn().mockResolvedValue('/opt/tool');
    const servers: KiroAcpMcpServer[] = [
      { type: 'stdio', name: 's', command: '${secret:bin-path}', args: [], env: [] },
    ];
    const resolved = await resolveMcpServerSecrets(servers, fetchSecret);
    const s = resolved[0] as Extract<KiroAcpMcpServer, { type: 'stdio' }>;
    expect(s.command).toBe('/opt/tool');
    expect(fetchSecret).toHaveBeenCalledWith('remote-swe/mcp-secrets/bin-path');
  });

  test('drops a stdio server whose command has an unresolvable/invalid placeholder', async () => {
    const fetchSecret = vi.fn();
    const servers: KiroAcpMcpServer[] = [
      { type: 'stdio', name: 'bad', command: '${secret:..}', args: [], env: [] },
      { type: 'stdio', name: 'ok', command: 'node', args: [], env: [] },
    ];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const resolved = await resolveMcpServerSecrets(servers, fetchSecret);
    expect(resolved.map((s) => s.name)).toEqual(['ok']);
    expect(errorSpy).toHaveBeenCalled();
  });

  test('drops a server whose secret name is invalid (path traversal attempt)', async () => {
    const fetchSecret = vi.fn();
    const servers = [stdioServer({ P: '${secretFile:../etc/passwd}' }), stdioServer({ OK: 'fine' })];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const resolved = await resolveMcpServerSecrets(servers, fetchSecret);
    expect(resolved).toHaveLength(1);
    expect((resolved[0] as any).env).toEqual([{ name: 'OK', value: 'fine' }]);
    expect(fetchSecret).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });

  test('drops only the failing server when the secret fetch rejects', async () => {
    const fetchSecret = vi.fn().mockRejectedValue(new Error('AccessDenied'));
    const servers = [stdioServer({ T: '${secret:missing}' }), stdioServer({ OK: 'fine' })];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const resolved = await resolveMcpServerSecrets(servers, fetchSecret);
    expect(resolved).toHaveLength(1);
    expect((resolved[0] as any).env).toEqual([{ name: 'OK', value: 'fine' }]);
    expect(errorSpy).toHaveBeenCalled();
  });

  test('caches fetches across servers within one resolution pass', async () => {
    const fetchSecret = vi.fn().mockResolvedValue('v');
    const servers = [stdioServer({ A: '${secret:shared}' }), stdioServer({ B: '${secret:shared}' })];
    await resolveMcpServerSecrets(servers, fetchSecret);
    expect(fetchSecret).toHaveBeenCalledTimes(1);
  });

  test.each(['.', '..', '...', '-', '_', '._-', ''])(
    'rejects dot-only / separator-only secret name %j (requires at least one alphanumeric)',
    async (name) => {
      const fetchSecret = vi.fn();
      const servers = [stdioServer({ P: `\${secret:${name}}` })];
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const resolved = await resolveMcpServerSecrets(servers, fetchSecret);
      expect(resolved).toHaveLength(0);
      expect(fetchSecret).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalled();
    }
  );

  test('accepts a valid dotted secret name (e.g. google.oauth-token_v1)', async () => {
    const fetchSecret = vi.fn().mockResolvedValue('v');
    const servers = [stdioServer({ P: '${secret:google.oauth-token_v1}' })];
    const resolved = await resolveMcpServerSecrets(servers, fetchSecret);
    expect(resolved).toHaveLength(1);
    expect(fetchSecret).toHaveBeenCalledWith('remote-swe/mcp-secrets/google.oauth-token_v1');
  });

  test('defence-in-depth: resolves a ${secret:} placeholder in an http header value (future-caller path)', async () => {
    // parseCustomAgentMcpConfig currently always emits headers: [], so this
    // path is unreachable from the production caller today. This guards a
    // FUTURE caller that supplies header values: they must be resolved, not
    // spread through unresolved.
    const fetchSecret = vi.fn().mockResolvedValue('bearer-value');
    const servers: KiroAcpMcpServer[] = [
      {
        type: 'http',
        name: 'h',
        url: 'https://example.com/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer ${secret:api}' }],
      },
    ];
    const resolved = await resolveMcpServerSecrets(servers, fetchSecret);
    const h = resolved[0] as Extract<KiroAcpMcpServer, { type: 'http' }>;
    expect(h.headers).toEqual([{ name: 'Authorization', value: 'Bearer bearer-value' }]);
    expect(fetchSecret).toHaveBeenCalledWith('remote-swe/mcp-secrets/api');
  });

  test('defence-in-depth: drops an http server whose header has an unresolvable placeholder', async () => {
    const fetchSecret = vi.fn().mockRejectedValue(new Error('AccessDenied'));
    const servers: KiroAcpMcpServer[] = [
      {
        type: 'http',
        name: 'bad-header',
        url: 'https://example.com/mcp',
        headers: [{ name: 'Authorization', value: 'Bearer ${secret:missing}' }],
      },
    ];
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const resolved = await resolveMcpServerSecrets(servers, fetchSecret);
    expect(resolved).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalled();
  });

  test('secretFileDir is a per-process random subdir under tmpdir and is stable within the process', () => {
    const first = __internal.secretFileDir();
    const second = __internal.secretFileDir();
    expect(first).toBe(second); // stable within the process (reuse-key stability)
    expect(first).toMatch(/remote-swe-mcp-secrets-[0-9a-f]{16}$/);
  });
});
