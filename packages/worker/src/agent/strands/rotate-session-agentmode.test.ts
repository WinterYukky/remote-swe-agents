import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { rotateSessionForModel, type RotateSessionDeps, type RotateSessionInput } from './rotate-session-for-model';
import {
  synthesizeKiroSessionFilesV3,
  readKiroV3SessionModelId,
  kiroV3SessionFilesExist,
  kiroV3SessionDir,
} from '../kiro-session-synth';
import type { MessageItem } from '@remote-swe-agents/agent-core/schema';

/**
 * Rotation-path regression (Critical): on a model-switch turn the loop
 * rotates to a FRESH sessionId via rotateSessionForModel, then agent.start()
 * issues session/load for that new id. KAS's hydrateSessionForLoad reads the
 * PERSISTED session.json `agentMode` and ignores the request modeId, so unless
 * rotation's synthesize forwards the custom-agent profile, the rotated
 * session.json is written as 'vibe' and the remote-swe MCP profile is dropped
 * for that turn.
 *
 * This test drives the REAL rotateSessionForModel with the SAME wrapped
 * `synthesize` dependency the production loop uses
 * (`(opts) => synthesizeKiroSessionFilesV3({ ...opts, agentMode: ctx.kiroAgentName })`)
 * and the REAL synthesizeKiroSessionFilesV3, then reads back the rotated
 * session.json exactly as the subsequent cold load would. Litmus: dropping the
 * `agentMode` from the wrapper makes the first assertion fail (mode falls back
 * to 'vibe') — see the second test which pins that failure mode.
 */
describe('rotation writes the custom-agent agentMode that the cold load then reads', () => {
  let home: string;
  const cwd = '/tmp/rotate-agentmode-cwd';
  const AGENT = 'remote-swe-worker';

  const history: MessageItem[] = [
    {
      PK: 'message-w-rot',
      SK: '001',
      role: 'user',
      content: JSON.stringify([{ text: 'hello' }]),
      messageType: 'userMessage',
      tokenCount: 10,
    },
    {
      PK: 'message-w-rot',
      SK: '002',
      role: 'assistant',
      content: JSON.stringify([{ text: 'hi' }]),
      messageType: 'assistant',
      tokenCount: 5,
    },
    {
      PK: 'message-w-rot',
      SK: '003',
      role: 'user',
      content: JSON.stringify([{ text: 'switch model now' }]),
      messageType: 'userMessage',
      tokenCount: 8,
    },
  ];

  beforeEach(async () => {
    home = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'kiro-rot-mode-'));
  });
  afterEach(async () => {
    await fs.promises.rm(home, { recursive: true, force: true });
  });

  it('rotated session.json carries agentMode=<profile>, readable before load (wrapper forwards agentMode)', async () => {
    const newSessionId = 'session-rotated-new';
    // Production wrapper shape from kiro-acp-sdk-agent-loop runColdSessionSetup.
    const deps: RotateSessionDeps = {
      synthesize: (opts) => synthesizeKiroSessionFilesV3({ ...opts, home, agentMode: AGENT }),
      readModelId: (sessionId) => readKiroV3SessionModelId(sessionId, cwd, home),
      sessionFilesExist: (sessionId) => kiroV3SessionFilesExist(sessionId, cwd, home),
      persistSessionId: async () => {},
      generateSessionId: () => newSessionId,
    };
    const input: RotateSessionInput = {
      workerId: 'w-rot',
      currentSessionId: 'session-old',
      desiredModel: 'claude-sonnet-4.5', // differs from live (auto) → rotation fires
      history,
      consumedTailCount: 1,
      cwd,
    };

    const result = await rotateSessionForModel(input, deps);
    if (!result.ok) throw new Error('rotation unexpectedly failed');
    expect(result.newSessionId).toBe(newSessionId);

    // Read the rotated session.json exactly as KAS session/load would.
    const jsonPath = path.join(kiroV3SessionDir(newSessionId, cwd, home), 'session.json');
    const meta = JSON.parse(await fs.promises.readFile(jsonPath, 'utf8'));
    expect(meta.agentMode).toBe(AGENT);
  });

  it('without the agentMode wrapper the rotated session would default to vibe (pins the failure mode the fix guards)', async () => {
    // Encodes the merge-regression state: an UNWRAPPED synthesize leaves the
    // rotated session at the default 'vibe', which is exactly what dropped the
    // remote-swe profile on model-switch turns.
    const newSessionId = 'session-rotated-unwrapped';
    const deps: RotateSessionDeps = {
      synthesize: (opts) => synthesizeKiroSessionFilesV3({ ...opts, home }), // NO agentMode
      readModelId: (sessionId) => readKiroV3SessionModelId(sessionId, cwd, home),
      sessionFilesExist: (sessionId) => kiroV3SessionFilesExist(sessionId, cwd, home),
      persistSessionId: async () => {},
      generateSessionId: () => newSessionId,
    };
    const input: RotateSessionInput = {
      workerId: 'w-rot',
      currentSessionId: 'session-old',
      desiredModel: 'claude-sonnet-4.5',
      history,
      consumedTailCount: 1,
      cwd,
    };
    await rotateSessionForModel(input, deps);
    const jsonPath = path.join(kiroV3SessionDir(newSessionId, cwd, home), 'session.json');
    const meta = JSON.parse(await fs.promises.readFile(jsonPath, 'utf8'));
    expect(meta.agentMode).toBe('vibe');
  });
});
