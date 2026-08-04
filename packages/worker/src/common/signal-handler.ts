import { closeMcpServers } from '../agent/mcp';
import { getSession, sendSystemMessage } from '@remote-swe-agents/agent-core/lib';
import { notifyTermination } from './notify-termination';
import { updateAgentStatusWithEvent } from './status';

// The workerId this process is serving, captured at startup by entry.main().
// Falls back to the EC2 env var. Used to notify the parent if the process is
// terminated (deploy SIGTERM / agent-core eviction) while a turn is running.
let activeWorkerId: string | undefined = process.env.WORKER_ID;
export const setActiveWorkerId = (workerId: string) => {
  activeWorkerId = workerId;
};

// Callback to cancel active CancellationTokens held by ConverseSessionTracker.
// Set by entry.ts after the tracker is created. Called during SIGTERM to signal
// backends to stop immediately — prevents duplicate "An error occurred" messages.
let cancelActiveTokensFn: (() => void) | undefined;
export const setCancelActiveTokens = (fn: () => void) => {
  cancelActiveTokensFn = fn;
};

// Notify the parent if the process is terminated while a turn is in progress
// (agentStatus === 'working') — the child died mid-task, so wake the parent.
// Idle/slept sessions are skipped: the kill timer already emits [Child sleeping]
// before stopMyself triggers this signal, so notifying here would be a false
// [Child error]. Known gap: SIGKILL / OOM cannot be trapped (no JS runs), so the
// parent is not notified in those cases — out of scope here (needs a watchdog).
// Exported for unit testing.
export const notifyTerminationIfActiveTurn = async (signal: string): Promise<void> => {
  if (!activeWorkerId) return;
  try {
    const session = await getSession(activeWorkerId);
    if (session?.agentStatus !== 'working') return;
  } catch (e) {
    console.error('[signal-handler] getSession failed during termination notify:', e);
    return;
  }
  // Each step is individually error-isolated so a failure in one (e.g.
  // sendSystemMessage DDB throttle) does not prevent the others from running.
  const feedbackText = 'Agent work was stopped.';
  try {
    await sendSystemMessage(activeWorkerId, feedbackText);
  } catch (e) {
    console.error('[signal-handler] sendSystemMessage failed:', e);
  }
  try {
    await updateAgentStatusWithEvent(activeWorkerId, 'pending');
  } catch (e) {
    console.error('[signal-handler] updateAgentStatusWithEvent failed:', e);
  }
  try {
    await notifyTermination(
      activeWorkerId,
      'error',
      `Worker process received ${signal} while a turn was in progress (runtime shutdown / eviction). The turn did not complete.`
    );
  } catch (e) {
    console.error('[signal-handler] notifyTermination failed:', e);
  }
};

const exit = async (signal: string) => {
  console.log(`${signal} received. Now shutting down ... please wait`);
  // Establish the hard 10s upper bound FIRST so a DDB stall in the termination
  // notify or MCP teardown can never exceed it.
  const forceExitTimer = setTimeout(() => {
    console.warn('[signal-handler] graceful shutdown exceeded 10s; forcing process.exit(0)');
    process.exit(0);
  }, 10000);
  // Cancel active CancellationTokens so in-flight agent loops exit cleanly.
  if (cancelActiveTokensFn) {
    try {
      cancelActiveTokensFn();
    } catch (e) {
      console.error('[signal-handler] cancelActiveTokens error:', e);
    }
  }
  await notifyTerminationIfActiveTurn(signal);
  await closeMcpServers();
  clearTimeout(forceExitTimer);
  process.exit(0);
};

process.on('SIGHUP', () => {
  exit('SIGHUP');
});

process.on('SIGINT', () => {
  exit('SIGINT');
});

process.on('SIGTERM', () => {
  exit('SIGTERM');
});

console.log(`[signal-handler] registered (pid=${process.pid}, ppid=${process.ppid})`);
