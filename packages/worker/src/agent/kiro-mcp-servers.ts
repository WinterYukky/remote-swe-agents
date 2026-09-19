import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';
import type { KiroAcpMcpServer } from '@remote-swe-agents/agent-core/lib';
import { EmptyMcpConfig, mcpConfigSchema, type CustomAgent } from '@remote-swe-agents/agent-core/schema';
import { getOrStartKiroMcpHttpServer } from './kiro-mcp-http';
import { resolveMcpServerSecrets } from './kiro-mcp-secrets';

/**
 * Which transport to expose the remote-swe MCP server over:
 *   - 'stdio' (default): subprocess + stdio, 1:1 pair with the kiro-cli
 *     subprocess. Each new kiro-cli respawn gets a fresh MCP child that
 *     is guaranteed not to carry over any per-session state from the
 *     previous subprocess.
 *   - 'http'          : localhost HTTP + shared-secret. Opt-in via
 *     `KIRO_MCP_TRANSPORT=http` for debugging or as a rollback. Known
 *     issue (April 2026): the server side of
 *     StreamableHTTPServerTransport keeps the first subprocess's
 *     Mcp-Session-Id after a SIGTERM-driven respawn; the new kiro-cli
 *     subprocess cannot re-initialise (4xx) and OAuth-discovery
 *     fallback triggers with no tools registered. The stdio path side-
 *     steps that because it is cleanly torn down together with the
 *     kiro-cli subprocess.
 *
 * `KIRO_MCP_DISABLED=1` still suppresses the remote-swe server entirely.
 */
const resolveTransport = (): 'http' | 'stdio' => {
  const v = (process.env.KIRO_MCP_TRANSPORT ?? 'stdio').toLowerCase();
  return v === 'http' ? 'http' : 'stdio';
};

/**
 * Resolve the command kiro-cli uses to spawn the remote-swe MCP server.
 *
 * The agent-core package's `./mcp-server/bin` export points at the compiled
 * JS under `dist/mcp-server/bin.js`. In production we run through `tsx` so
 * we hand kiro-cli the source TypeScript path via tsx instead — that matches
 * how the worker itself is launched (see packages/worker/run.sh:
 * `node --import tsx src/agent-core.ts`).
 *
 * IMPORTANT (the MCP-exposure fix connect-flake fix): we spawn via
 * `<node> --import <tsx-loader> <bin.ts>` and NOT via `npx tsx <bin.ts>`.
 * `npx` re-resolves the `tsx` bin on every spawn and adds an extra Node
 * process layer, which made the stdio MCP subprocess's cold start slow AND
 * high-variance (measured ~1.66s mean, up to 4–11s under container CPU
 * contention per KAS mcp.log `connectDurationMs`). KAS silently drops a
 * server whose connect exceeds its deadline (`mcp.connect.error` →
 * `actualStatus:removed`, suppressed), so a slow spawn = the remote-swe
 * tools vanish for that turn. Spawning `node` directly with an absolute
 * loader path removes the npx resolution entirely (measured ~1.26s mean,
 * ~24% faster and far tighter variance), widening the race margin.
 */
const resolveRemoteSweMcpBin = (): { command: string; args: string[] } => {
  // Prefer src/mcp-server/bin.ts via tsx, because the worker runtime already
  // uses tsx to execute the agent-core source tree. This keeps a single
  // source-of-truth (no extra build step) and dodges the Node-ESM
  // "missing .js extension" issue we hit when running compiled dist.
  const require = createRequire(import.meta.url);
  // Anchor off agent-core's package.json rather than a compiled `./dist`
  // subpath: package.json always exists in the source tree, so this resolves
  // identically whether or not agent-core has been built (dev/test vs prod).
  // The previous `./mcp-server` anchor required `dist/` to exist and broke the
  // MCP-server spawn path (and these tests) on an unbuilt checkout.
  const anchor = require.resolve('@remote-swe-agents/agent-core/package.json');
  const agentCoreRoot = path.dirname(anchor);
  const srcBin = path.join(agentCoreRoot, 'src', 'mcp-server', 'bin.ts');
  // Resolve the tsx ESM loader to an absolute path so the spawn is
  // independent of the child process's CWD (kiro-cli chooses it) and of
  // PATH. This is the same loader the worker itself is started with.
  const tsxLoader = require.resolve('tsx');
  return {
    command: process.execPath,
    args: ['--import', tsxLoader, srcBin],
  };
};

const envRecordToAcpArray = (env: Record<string, string> | undefined): { name: string; value: string }[] => {
  if (!env) return [];
  return Object.entries(env).map(([name, value]) => ({ name, value: String(value) }));
};

/**
 * Non-secret configuration env vars that the remote-swe MCP tools need at
 * runtime (region + resource names/ARNs + endpoints + param-NAME references +
 * paths + numeric tuning + feature flags). These are injected into the base
 * worker agent PROFILE's `mcpServers.env` (written to disk), so this list is a
 * strict ALLOWLIST — fail-safe by construction: a missing entry only breaks a
 * tool (fixed by adding the key), whereas a passthrough/denylist risks writing
 * a credential to disk if a new secret var is introduced.
 *
 * DELIBERATELY EXCLUDED (secret VALUES — must never be written to the profile
 * JSON): `SLACK_BOT_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN`. Their param-NAME /
 * path references (e.g. `GITHUB_APP_PRIVATE_KEY_PATH`) are non-secret and ARE
 * forwarded; the tools resolve the secret VALUE at runtime (SSM / file) using
 * AWS credentials — which are NOT forwarded here either (see
 * buildRemoteSweProfileMcpServers).
 */
const PROFILE_CONFIG_ENV_ALLOWLIST = [
  'AWS_REGION',
  'AWS_DEFAULT_REGION',
  'AGENT_RUNTIME_ARN',
  'BUCKET_NAME',
  'SKILL_BUCKET_NAME',
  'SKILLS_LOCAL_DIR',
  'TABLE_NAME',
  'DYNAMODB_ENDPOINT',
  'EVENT_HTTP_ENDPOINT',
  'EVENT_TRIGGER_RESOURCE_PREFIX',
  'EVENT_TRIGGER_SFN_ARN',
  'EVENT_TRIGGER_SFN_ROLE_ARN',
  'EVENT_TRIGGER_TTL_SFN_ARN',
  'EVENT_TRIGGER_TTL_SFN_ROLE_ARN',
  'KIRO_WORKSPACE_BASE',
  'STACK_NAME',
  'SUBNET_ID_LIST',
  'PREVIEW_MICROVM_IMAGE_ARN',
  'WORKER_RUNTIME',
  'WORKER_AMI_PARAMETER_NAME',
  'WORKER_LAUNCH_TEMPLATE_ID',
  'WEBAPP_ORIGIN_NAME_PARAMETER',
  'BEDROCK_AWS_ACCOUNTS',
  'BEDROCK_AWS_ROLE_NAME',
  'BEDROCK_CRI_REGION_OVERRIDE',
  'NEXT_PUBLIC_BEDROCK_CRI_REGION_OVERRIDE',
  // GitHub App config: id/installation + PRIVATE_KEY_PATH (a path, not the key).
  'GITHUB_APP_ID',
  'GITHUB_APP_INSTALLATION_ID',
  'GITHUB_APP_PRIVATE_KEY_PATH',
  // Wait-tool numeric tuning + test flags (non-secret).
  'WAIT_TOOL_BACKOFF_MULTIPLIER',
  'WAIT_TOOL_CHECK_COMMAND_TIMEOUT_MS',
  'WAIT_TOOL_DEFAULT_MAX_WAIT_SECONDS',
  'WAIT_TOOL_INITIAL_INTERVAL_MS',
  'WAIT_TOOL_MAX_INTERVAL_MS',
  'WAIT_TOOL_MAX_REGEX_INPUT_CHARS',
  'WAIT_TOOL_MAX_WAIT_CEILING_SECONDS',
  'REMOTE_SWE_TEST_EVENT_DROP_ENABLED',
  // Timezone config (#322): the stack injects these into the AgentCore/EC2
  // env so tools' time-of-day output (toLocaleString() etc.) is local time.
  // Both are non-secret and must be forwarded to the profile-owned subprocess.
  'TZ',
  'AGENT_TIMEZONE',
] as const;

/**
 * Env-var name substrings that must NEVER be written to the profile JSON,
 * even if accidentally added to the allowlist. Defence-in-depth guard for the
 * "no secret on disk" invariant (belt-and-suspenders on top of the allowlist).
 */
const SECRET_ENV_DENY_SUBSTRINGS = [
  'TOKEN',
  'SECRET',
  'PASSWORD',
  'PASSPHRASE',
  'CREDENTIAL',
  'PRIVATE_KEY',
  'ACCESS_KEY',
  'API_KEY',
] as const;
const isSecretEnvName = (name: string): boolean => {
  // GITHUB_APP_PRIVATE_KEY_PATH is a filesystem path, not the key material.
  if (name === 'GITHUB_APP_PRIVATE_KEY_PATH') return false;
  const upper = name.toUpperCase();
  return SECRET_ENV_DENY_SUBSTRINGS.some((s) => upper.includes(s));
};

/**
 * Build the non-secret configuration env record for the profile-owned
 * remote-swe MCP server. KAS spawns a profile server with
 * `{ ...getDefaultEnvironment(), ...config.env }`, where getDefaultEnvironment()
 * (unix) is only HOME/LOGNAME/PATH/SHELL/TERM/USER — it does NOT forward the
 * worker's process env. So the config the tools need must be injected here.
 *
 * AWS CREDENTIALS are intentionally NOT injected: the AgentCore container has
 * no static AWS_* creds and no AWS_CONTAINER_CREDENTIALS_* URI; the SDK default
 * provider chain resolves them from the HOME-based cred cache
 * (`~/.aws/cli/cache/...`), and HOME is one of KAS's forwarded safe-6 vars, so
 * credentials already reach the subprocess. (Empirically verified: safe-6 +
 * AWS_REGION + TABLE_NAME succeeds at a real DynamoDB call with zero creds in
 * env.) This keeps ZERO secrets in the on-disk profile JSON.
 */
const buildProfileConfigEnv = (workerId: string): Record<string, string> => {
  const env: Record<string, string> = { WORKER_ID: workerId };
  for (const key of PROFILE_CONFIG_ENV_ALLOWLIST) {
    if (isSecretEnvName(key)) continue; // guard: never emit a secret-named var
    const v = process.env[key];
    if (v !== undefined) env[key] = v;
  }
  return env;
};

/**
 * Parse the JSON-encoded `customAgent.mcpConfig` string into ACP-shaped
 * server descriptors. Invalid JSON or schema mismatches silently fall back
 * to an empty list rather than breaking the Kiro session.
 */
const parseCustomAgentMcpConfig = (customAgent: CustomAgent): KiroAcpMcpServer[] => {
  if (!customAgent.mcpConfig) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(customAgent.mcpConfig);
  } catch (e) {
    console.error('[kiro-mcp-servers] failed to parse customAgent.mcpConfig JSON:', e);
    return [];
  }
  const parsed = mcpConfigSchema.safeParse(raw);
  if (!parsed.success) {
    console.error('[kiro-mcp-servers] customAgent.mcpConfig does not match schema:', parsed.error.message);
    return [];
  }
  const result: KiroAcpMcpServer[] = [];
  for (const [name, entry] of Object.entries(parsed.data.mcpServers)) {
    if (entry.enabled === false) continue;
    if ('url' in entry) {
      // http custom-agent servers carry no headers: mcpConfigSchema's url
      // variant has no `headers` field, so there is nothing to populate (and
      // resolveMcpServerSecrets does not inject secrets into a url — see its
      // doc). `headers: []` satisfies the ACP type only. Secret injection is
      // supported for stdio env/args/command; use a stdio server for that.
      result.push({ type: 'http', name, url: entry.url, headers: [] });
    } else {
      result.push({
        type: 'stdio',
        name,
        command: entry.command,
        args: entry.args,
        env: envRecordToAcpArray(entry.env),
      });
    }
  }
  return result;
};

/**
 * Build the full list of MCP servers to expose to a Kiro session.
 *
 * Layout:
 *   1. `remote-swe` (our curated catalogue) — always present unless disabled
 *      via `KIRO_MCP_DISABLED=1` for debugging.
 *   2. Any user-defined MCP servers from the custom agent's mcpConfig,
 *      translated from the internal record shape into ACP's array shape.
 */
export const buildKiroMcpServerList = async (opts: {
  workerId: string;
  customAgent: CustomAgent;
}): Promise<KiroAcpMcpServer[]> => {
  if (process.env.KIRO_MCP_DISABLED === '1') {
    return await resolveMcpServerSecrets(parseCustomAgentMcpConfig(opts.customAgent));
  }

  const transport = resolveTransport();
  // on the default stdio transport the remote-swe server is declared in
  // the base worker AGENT PROFILE (see buildRemoteSweProfileMcpServers +
  // deployKiroWorkspaceFiles), NOT sent as an ACP client server. That is the
  // only placement where KAS (a) exposes its tools via includeMcpJson AND
  // (b) honours waitForReady on the profile-resolution path so tool-selection
  // waits for the connect. Sending it ALSO as a client server would double-spawn
  // it, so we omit it here and let the profile own it. Custom-agent servers are
  // unchanged (still client-supplied; profile-ownership for those is MCP-E).
  // The http transport (opt-in) cannot be profile-owned (its bearer secret must
  // not be written to the profile JSON), so it stays client-supplied; its
  // exposure is tracked under MCP-C.
  if (transport === 'http') {
    const remoteSwe = await buildRemoteSweHttpDescriptor(opts.workerId);
    return [remoteSwe, ...(await resolveMcpServerSecrets(parseCustomAgentMcpConfig(opts.customAgent)))];
  }

  return [...(await resolveMcpServerSecrets(parseCustomAgentMcpConfig(opts.customAgent)))];
};

/**
 * build the remote-swe entry for the base worker agent PROFILE's
 * `mcpServers` block (record keyed by server name, KAS agent-profile wire
 * shape). Declaring remote-swe in the profile is what makes KAS expose its
 * tools (`includeMcpJson`) and, critically, honour `waitForReady` on the
 * profile-resolution path so tool-selection blocks until the connect completes.
 *
 * ENV: KAS spawns a profile server with only its default 6 env vars
 * (HOME/LOGNAME/PATH/SHELL/TERM/USER) plus this `env` — it does NOT forward the
 * worker's process env. So we inject the non-secret CONFIG the tools need
 * (buildProfileConfigEnv: region, table/bucket names, ARNs, endpoints, param
 * NAMEs, paths, flags — via a strict allowlist). NO secrets and NO AWS
 * credentials are written to disk: creds resolve at runtime from the HOME-based
 * cred cache (HOME is in KAS's forwarded 6), and secret VALUES (SLACK_BOT_TOKEN,
 * GITHUB_PERSONAL_ACCESS_TOKEN) are resolved at runtime from SSM/file, not here.
 *
 * Returns undefined for the http transport (opt-in; cannot be profile-owned
 * because its bearer secret must not be written to the profile JSON — tracked
 * under MCP-C).
 */
export const buildRemoteSweProfileMcpServers = (workerId: string): Record<string, unknown> | undefined => {
  if (process.env.KIRO_MCP_DISABLED === '1') return undefined;
  if (resolveTransport() === 'http') return undefined;
  const { command, args } = resolveRemoteSweMcpBin();
  return {
    'remote-swe': {
      command,
      args,
      env: buildProfileConfigEnv(workerId),
      waitForReady: true,
    },
  };
};

/**
 * http transport (opt-in via KIRO_MCP_TRANSPORT=http): spawn a long-lived
 * localhost HTTP MCP server inside the worker process and hand kiro-cli its
 * URL + bearer secret. The default transport is stdio (see resolveTransport).
 * See packages/worker/src/agent/kiro-mcp-http.ts for the lifecycle.
 */
const buildRemoteSweHttpDescriptor = async (workerId: string): Promise<KiroAcpMcpServer> => {
  const running = await getOrStartKiroMcpHttpServer(workerId);
  return {
    type: 'http',
    name: 'remote-swe',
    url: running.url,
    headers: [{ name: 'Authorization', value: `Bearer ${running.secret}` }],
    // the MCP-exposure fix defence-in-depth: make KAS await this server's connect before
    // assembling the turn's tool set (see KiroAcpMcpServer.waitForReady).
    waitForReady: true,
  };
};

// Re-export for worker-side unit tests.
export const __internal = {
  envRecordToAcpArray,
  parseCustomAgentMcpConfig,
  fingerprintMcpServers: (servers: KiroAcpMcpServer[]): string => JSON.stringify(servers),
  buildProfileConfigEnv,
  isSecretEnvName,
  PROFILE_CONFIG_ENV_ALLOWLIST,
  resolveRemoteSweMcpBin,
};

// keep TS happy — fileURLToPath is only used if we later add __dirname-style resolution fallbacks.
void fileURLToPath;
