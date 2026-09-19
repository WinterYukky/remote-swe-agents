// Live-path test harness for the stdin-EOF -> process.exit(0) fix.
//
// It runs the REAL runStdioServer() and, to reproduce the SIGKILL orphan
// scenario, installs a keep-alive timer that holds the Node event loop open
// exactly the way an active preview's token-refresh timer + tunnel WebSocket
// would. If runStdioServer did NOT install a stdin-EOF handler, ending stdin
// would leave this process alive forever (the interval keeps the loop busy and
// no SIGTERM is delivered), and the spawning test would time out. With the fix,
// stdin EOF triggers detach + process.exit(0).
//
// NOTE: WORKER_RUNTIME is intentionally left unset so adoptPreview() short-
// circuits before any AWS/DDB call; this harness needs no cloud access.
import { runStdioServer } from '../server';

// Simulate the preview keeping the event loop alive. Deliberately NOT unref'd.
const keepAlive = setInterval(() => {}, 1000);
void keepAlive;

runStdioServer().catch((e) => {
  console.error('[stdin-eof-harness] runStdioServer failed:', e);
  process.exit(1);
});
