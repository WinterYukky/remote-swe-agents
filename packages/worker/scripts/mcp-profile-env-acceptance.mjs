// Acceptance regression probe (profile-env review finding).
//
// Purpose: prove that the profile-owned remote-swe MCP server, spawned with the
// EXACT environment KAS gives a profile server (getDefaultEnvironment() safe-6
// + the profile's config.env), can actually run an AWS-touching tool. The
// config.env is produced by the REAL production function
// `buildRemoteSweProfileMcpServers` (imported below via tsx), so this fails if
// the non-secret config allowlist regresses. It asserts:
//   - NO AWS credentials and NO secret tokens are present in the profile env
//     (they must resolve at runtime from the HOME-based cred cache instead), and
//   - JSON-RPC `tools/call "List Event Triggers"` succeeds (NOT "Region is
//     missing"), i.e. region + TABLE_NAME + creds all resolved.
//
// Run from anywhere:  node packages/worker/scripts/mcp-profile-env-acceptance.mjs
// (it re-execs itself under the repo's tsx loader so it can import the .ts
// production module; no env vars or hardcoded paths required).
import { spawn } from 'child_process';
import { createRequire } from 'module';
import { fileURLToPath, pathToFileURL } from 'url';
import path from 'path';

const __filename = fileURLToPath(import.meta.url);
// scripts/ -> worker/ -> packages/ -> <repoRoot>
const workerRoot = path.resolve(path.dirname(__filename), '..');
const repoRoot = path.resolve(workerRoot, '..', '..');
const require = createRequire(path.join(workerRoot, 'package.json'));
const tsxLoader = require.resolve('tsx');

// tsx registers a loader for the current process only. Since we need to import
// a .ts module (kiro-mcp-servers.ts), re-exec self under `node --import tsx`
// unless we are already running under it.
if (!process.env.__ACC_TSX__) {
  const child = spawn(process.execPath, ['--import', tsxLoader, __filename], {
    stdio: 'inherit',
    env: { ...process.env, __ACC_TSX__: '1' },
  });
  child.on('exit', (code) => process.exit(code ?? 1));
} else {
  await main();
}

async function main() {
  // Import the REAL production function and build the profile entry.
  const mod = await import(pathToFileURL(path.join(workerRoot, 'src', 'agent', 'kiro-mcp-servers.ts')).href);
  const rec = mod.buildRemoteSweProfileMcpServers('acceptance-worker');
  if (!rec || !rec['remote-swe']) {
    console.log('PROFILE_ENTRY_MISSING (stdio transport expected; is KIRO_MCP_TRANSPORT=http or KIRO_MCP_DISABLED set?)');
    process.exit(2);
  }
  const server = rec['remote-swe'];

  // KAS getDefaultEnvironment (unix) = these 6 only, then + config.env.
  const safe6 = {
    HOME: process.env.HOME || '/root',
    LOGNAME: process.env.LOGNAME || 'root',
    PATH: process.env.PATH,
    SHELL: process.env.SHELL || '/bin/sh',
    TERM: process.env.TERM || 'xterm',
    USER: process.env.USER || 'root',
  };
  const childEnv = { ...safe6, ...server.env };

  console.log('REPO_ROOT=' + repoRoot);
  console.log('CONFIG_ENV_KEYS=' + Object.keys(server.env).sort().join(','));
  console.log(
    'HAS_AWS_CREDS_IN_ENV=' +
      (childEnv.AWS_ACCESS_KEY_ID || childEnv.AWS_SECRET_ACCESS_KEY || childEnv.AWS_SESSION_TOKEN ? 'YES(BAD)' : 'no(good)')
  );
  console.log('HAS_SLACK_TOKEN_IN_ENV=' + (childEnv.SLACK_BOT_TOKEN ? 'YES(BAD)' : 'no(good)'));

  const child = spawn(server.command, server.args, { stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
  let sbuf = '';
  child.stderr.on('data', (d) => (sbuf += d));
  let buf = '';
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  child.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const l = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!l.trim()) continue;
      let m;
      try {
        m = JSON.parse(l);
      } catch {
        continue;
      }
      if (m.id === 1) {
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
      } else if (m.id === 2) {
        const names = (m.result?.tools || []).map((t) => t.name);
        console.log('TOOLS_LIST_COUNT=' + names.length);
        console.log('HAS_LIST_EVENT_TRIGGERS=' + names.includes('List Event Triggers'));
        send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'List Event Triggers', arguments: {} } });
      } else if (m.id === 3) {
        if (m.error) {
          console.log('TOOLS_CALL_ERROR=' + JSON.stringify(m.error).slice(0, 300));
          child.kill();
          process.exit(1);
        }
        const txt = JSON.stringify(m.result).slice(0, 300);
        const regionMissing = /Region is missing/i.test(JSON.stringify(m.result));
        console.log('TOOLS_CALL_OK result=' + txt);
        console.log('REGION_MISSING=' + regionMissing);
        child.kill();
        process.exit(regionMissing ? 1 : 0);
      }
    }
  });
  setTimeout(
    () =>
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'acc', version: '0' } },
      }),
    50
  );
  setTimeout(() => {
    console.log('TIMEOUT stderr=' + sbuf.slice(-400));
    child.kill();
    process.exit(1);
  }, 60000);
}
