import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';

// --- Mocks ---------------------------------------------------------------

// Lambda MicroVMs SDK: a single shared send() mock. Commands are tagged with a
// discriminant so the send handler (and assertions) can tell them apart.
const mockMicrovmSend = vi.fn();
vi.mock('@aws-sdk/client-lambda-microvms', () => {
  class Cmd {
    __type: string;
    input: any;
    constructor(type: string, input: any) {
      this.__type = type;
      this.input = input;
    }
  }
  return {
    LambdaMicrovmsClient: class {
      send = (...args: any[]) => mockMicrovmSend(...args);
    },
    RunMicrovmCommand: class extends Cmd {
      constructor(input: any) {
        super('Run', input);
      }
    },
    CreateMicrovmAuthTokenCommand: class extends Cmd {
      constructor(input: any) {
        super('CreateToken', input);
      }
    },
    TerminateMicrovmCommand: class extends Cmd {
      constructor(input: any) {
        super('Terminate', input);
      }
    },
    GetMicrovmCommand: class extends Cmd {
      constructor(input: any) {
        super('Get', input);
      }
    },
  };
});

// DynamoDB doc client: shared send() mock; commands tagged like above.
const mockDdbSend = vi.fn();
vi.mock('../../lib/aws/ddb', () => ({
  ddb: { send: (...args: any[]) => mockDdbSend(...args) },
  TableName: 'test-table',
}));
vi.mock('../../lib/aws/ddb.js', () => ({
  ddb: { send: (...args: any[]) => mockDdbSend(...args) },
  TableName: 'test-table',
}));
vi.mock('@aws-sdk/lib-dynamodb', () => {
  class DdbCmd {
    __type: string;
    input: any;
    constructor(type: string, input: any) {
      this.__type = type;
      this.input = input;
    }
  }
  return {
    PutCommand: class extends DdbCmd {
      constructor(input: any) {
        super('Put', input);
      }
    },
    GetCommand: class extends DdbCmd {
      constructor(input: any) {
        super('GetDdb', input);
      }
    },
    DeleteCommand: class extends DdbCmd {
      constructor(input: any) {
        super('Delete', input);
      }
    },
  };
});

const mockWriteMetadata = vi.fn();
vi.mock('../../lib/metadata', () => ({ writeMetadata: (...a: any[]) => mockWriteMetadata(...a) }));
vi.mock('../../lib/metadata.js', () => ({ writeMetadata: (...a: any[]) => mockWriteMetadata(...a) }));

const mockSendWebappEvent = vi.fn();
vi.mock('../../lib/events', () => ({ sendWebappEvent: (...a: any[]) => mockSendWebappEvent(...a) }));
vi.mock('../../lib/events.js', () => ({ sendWebappEvent: (...a: any[]) => mockSendWebappEvent(...a) }));

vi.mock('../../lib/webapp-origin', () => ({ getWebappOrigin: async () => 'https://webapp.example.com' }));
vi.mock('../../lib/webapp-origin.js', () => ({ getWebappOrigin: async () => 'https://webapp.example.com' }));

// TunnelClient: capture instances so tests can assert connect/close/terminate.
const tunnelInstances: any[] = [];
const tunnelConnectImpl = { fn: async () => {} };
vi.mock('./tunnel-client', () => ({
  TunnelClient: class {
    connect = vi.fn(() => tunnelConnectImpl.fn());
    close = vi.fn();
    terminate = vi.fn();
    updateAuthToken = vi.fn();
    endpoint: string;
    tunnelPort: number;
    localPort: number;
    constructor(endpoint: string, tunnelPort: number, localPort: number, _token: string, _onDisconnect?: () => void) {
      this.endpoint = endpoint;
      this.tunnelPort = tunnelPort;
      this.localPort = localPort;
      tunnelInstances.push(this);
    }
  },
}));
vi.mock('./tunnel-client.js', () => ({
  TunnelClient: class {
    connect = vi.fn(() => tunnelConnectImpl.fn());
    close = vi.fn();
    terminate = vi.fn();
    updateAuthToken = vi.fn();
    endpoint: string;
    tunnelPort: number;
    localPort: number;
    constructor(endpoint: string, tunnelPort: number, localPort: number, _token: string, _onDisconnect?: () => void) {
      this.endpoint = endpoint;
      this.tunnelPort = tunnelPort;
      this.localPort = localPort;
      tunnelInstances.push(this);
    }
  },
}));

import { adoptPreview, openPreviewTool, terminatePreview, detachPreview } from './index';

const WORKER_ID = 'worker-abc';
const ctx = { workerId: WORKER_ID, toolUseId: 't', globalPreferences: {} } as any;

// Default DDB behaviour: no existing preview state, everything succeeds.
function ddbDefault(getItem: any = undefined) {
  mockDdbSend.mockImplementation(async (cmd: any) => {
    if (cmd.__type === 'GetDdb') return { Item: getItem };
    return {};
  });
}

// Default MicroVM send behaviour builder.
function microvmDefault(
  opts: {
    getState?: string | null; // state returned by GetMicrovm; null => throw NotFound
    getTerminatedAt?: boolean;
    runId?: string;
  } = {}
) {
  mockMicrovmSend.mockImplementation(async (cmd: any) => {
    switch (cmd.__type) {
      case 'Get': {
        if (opts.getState === null) {
          const e: any = new Error('not found');
          e.name = 'ResourceNotFoundException';
          throw e;
        }
        return {
          state: opts.getState ?? 'RUNNING',
          endpoint: 'live-endpoint.example.com',
          terminatedAt: opts.getTerminatedAt ? new Date() : undefined,
        };
      }
      case 'CreateToken':
        return { authToken: { 'X-aws-proxy-auth': 'tok-' + cmd.input.allowedPorts?.[0]?.port } };
      case 'Run':
        return { microvmId: opts.runId ?? 'vm-new', endpoint: 'new-endpoint.example.com' };
      case 'Terminate':
        return {};
      default:
        return {};
    }
  });
}

const findCmds = (mock: ReturnType<typeof vi.fn>, type: string) =>
  mock.mock.calls.map((c) => c[0]).filter((c: any) => c.__type === type);

beforeEach(() => {
  vi.clearAllMocks();
  tunnelInstances.length = 0;
  tunnelConnectImpl.fn = async () => {};
  process.env.WORKER_RUNTIME = 'agent-core';
  process.env.PREVIEW_MICROVM_IMAGE_ARN = 'arn:aws:lambda:us-east-1:123:image/img';
  process.env.AWS_REGION = 'us-east-1';
});

afterEach(async () => {
  // Ensure module-level activePreview is reset between tests: detach clears the
  // in-process timer/socket without terminating the MicroVM.
  detachPreview();
});

describe('adoptPreview', () => {
  test('success path: adopts a live persisted MicroVM and re-tunnels to stored port', async () => {
    ddbDefault({ microvmId: 'vm-1', endpoint: 'stored-endpoint.example.com', localPort: 5173 });
    microvmDefault({ getState: 'RUNNING' });

    const result = await adoptPreview(WORKER_ID);

    expect(result).not.toBeNull();
    expect(result!.microvmId).toBe('vm-1');
    expect(result!.localPort).toBe(5173);
    // Uses the endpoint returned by GetMicrovm (refreshed), not the stale one.
    expect(result!.microvmEndpoint).toBe('live-endpoint.example.com');
    // Tunnel established on the stored port.
    expect(tunnelInstances).toHaveLength(1);
    expect(tunnelInstances[0].localPort).toBe(5173);
    expect(tunnelInstances[0].connect).toHaveBeenCalledTimes(1);
    // MUST NOT terminate the adopted MicroVM.
    expect(findCmds(mockMicrovmSend, 'Terminate')).toHaveLength(0);
    // Browser token re-persisted with the port.
    const puts = findCmds(mockDdbSend, 'Put');
    expect(puts.length).toBeGreaterThan(0);
    expect(puts[0].input.Item.localPort).toBe(5173);
    // Metadata written + webapp notified so the URL survives.
    expect(mockWriteMetadata).toHaveBeenCalled();
    expect(mockSendWebappEvent).toHaveBeenCalled();
  });

  test('MicroVM-dead fallback: cleans up stale DDB + metadata and returns null', async () => {
    ddbDefault({ microvmId: 'vm-dead', endpoint: 'x', localPort: 3000 });
    microvmDefault({ getState: null }); // GetMicrovm throws NotFound

    const result = await adoptPreview(WORKER_ID);

    expect(result).toBeNull();
    // No tunnel attempted.
    expect(tunnelInstances).toHaveLength(0);
    // Stale MicroVM terminated (best-effort orphan cleanup) + token deleted.
    expect(findCmds(mockMicrovmSend, 'Terminate')).toHaveLength(1);
    expect(findCmds(mockDdbSend, 'Delete')).toHaveLength(1);
    // Metadata cleared (previewUrl null) + notify.
    expect(mockWriteMetadata).toHaveBeenCalledWith('previewSession', { previewUrl: null, localPort: null }, WORKER_ID);
  });

  test('terminatedAt set => treated as dead, cleaned up', async () => {
    ddbDefault({ microvmId: 'vm-term', endpoint: 'x', localPort: 3000 });
    microvmDefault({ getState: 'TERMINATED', getTerminatedAt: true });

    const result = await adoptPreview(WORKER_ID);
    expect(result).toBeNull();
    expect(tunnelInstances).toHaveLength(0);
    expect(findCmds(mockDdbSend, 'Delete')).toHaveLength(1);
  });

  test('no persisted state => no-op null, no side effects', async () => {
    ddbDefault(undefined);
    microvmDefault({});

    const result = await adoptPreview(WORKER_ID);
    expect(result).toBeNull();
    expect(findCmds(mockMicrovmSend, 'Get')).toHaveLength(0);
    expect(findCmds(mockMicrovmSend, 'Terminate')).toHaveLength(0);
  });

  test('persisted state without localPort => cannot adopt, cleaned up', async () => {
    ddbDefault({ microvmId: 'vm-old', endpoint: 'x' }); // no localPort (legacy record)
    microvmDefault({ getState: 'RUNNING' });

    const result = await adoptPreview(WORKER_ID);
    expect(result).toBeNull();
    expect(tunnelInstances).toHaveLength(0);
    expect(findCmds(mockDdbSend, 'Delete')).toHaveLength(1);
  });

  test('not agent-core runtime => no-op null', async () => {
    process.env.WORKER_RUNTIME = 'ec2';
    ddbDefault({ microvmId: 'vm-1', endpoint: 'x', localPort: 5173 });
    microvmDefault({ getState: 'RUNNING' });

    const result = await adoptPreview(WORKER_ID);
    expect(result).toBeNull();
    expect(mockDdbSend).not.toHaveBeenCalled();
  });

  test('transient GetMicrovm error => leaves state intact (no cleanup, no adopt)', async () => {
    ddbDefault({ microvmId: 'vm-1', endpoint: 'x', localPort: 5173 });
    mockMicrovmSend.mockImplementation(async (cmd: any) => {
      if (cmd.__type === 'Get') {
        const e: any = new Error('throttled');
        e.name = 'ThrottlingException';
        throw e;
      }
      return {};
    });

    const result = await adoptPreview(WORKER_ID);
    expect(result).toBeNull();
    // Must NOT terminate or delete on a transient error.
    expect(findCmds(mockMicrovmSend, 'Terminate')).toHaveLength(0);
    expect(findCmds(mockDdbSend, 'Delete')).toHaveLength(0);
  });

  // Adopt where the MicroVM is alive but the tunnel connect fails.
  test('tunnel connect failure => returns null, MicroVM + DDB state left intact, no leaked active preview', async () => {
    ddbDefault({ microvmId: 'vm-live', endpoint: 'x', localPort: 5173 });
    microvmDefault({ getState: 'RUNNING' });
    tunnelConnectImpl.fn = async () => {
      throw new Error('nonretryable boom');
    };

    const result = await adoptPreview(WORKER_ID);

    expect(result).toBeNull();
    // Adopt must NOT terminate the (alive) MicroVM nor delete its DDB record —
    // a later attempt should be able to retry.
    expect(findCmds(mockMicrovmSend, 'Terminate')).toHaveLength(0);
    expect(findCmds(mockDdbSend, 'Delete')).toHaveLength(0);
    // No active preview leaked: a subsequent openPreview must be free to create
    // a brand-new one (i.e. activePreview is null, so this path runs create).
    ddbDefault(undefined);
    microvmDefault({ runId: 'vm-after' });
    tunnelConnectImpl.fn = async () => {};
    const after = await openPreviewTool.handler({ port: 3000 }, ctx);
    expect(after).toContain('vm-after');
  });
});

describe('openPreview adopt-or-create', () => {
  test('reuses a live persisted MicroVM instead of terminating+recreating', async () => {
    ddbDefault({ microvmId: 'vm-existing', endpoint: 'stored', localPort: 3000 });
    microvmDefault({ getState: 'SUSPENDED' }); // suspended is adoptable

    const res = await openPreviewTool.handler({ port: 4000 }, ctx);

    expect(res).toContain('vm-existing');
    // Reused MicroVM => NO RunMicrovm, NO Terminate.
    expect(findCmds(mockMicrovmSend, 'Run')).toHaveLength(0);
    expect(findCmds(mockMicrovmSend, 'Terminate')).toHaveLength(0);
    // Re-tunnelled to the port requested in THIS call (4000), not the stored one.
    expect(tunnelInstances).toHaveLength(1);
    expect(tunnelInstances[0].localPort).toBe(4000);
  });

  test('dead persisted MicroVM => cleans up and creates a new one', async () => {
    ddbDefault({ microvmId: 'vm-dead', endpoint: 'stored', localPort: 3000 });
    // GetMicrovm returns terminated; Run returns a fresh vm.
    microvmDefault({ getState: 'TERMINATED', getTerminatedAt: true, runId: 'vm-fresh' });

    const res = await openPreviewTool.handler({ port: 3000 }, ctx);

    expect(res).toContain('vm-fresh');
    // Orphan terminated + new MicroVM created.
    expect(findCmds(mockMicrovmSend, 'Terminate').length).toBeGreaterThanOrEqual(1);
    expect(findCmds(mockMicrovmSend, 'Run')).toHaveLength(1);
    expect(tunnelInstances[tunnelInstances.length - 1].localPort).toBe(3000);
  });

  test('no persisted state => creates a new MicroVM', async () => {
    ddbDefault(undefined);
    microvmDefault({ runId: 'vm-brand-new' });

    const res = await openPreviewTool.handler({ port: 8080 }, ctx);

    expect(res).toContain('vm-brand-new');
    expect(findCmds(mockMicrovmSend, 'Run')).toHaveLength(1);
    expect(findCmds(mockMicrovmSend, 'Terminate')).toHaveLength(0);
  });

  test('already active => returns error without creating a MicroVM', async () => {
    // First open to set activePreview.
    ddbDefault(undefined);
    microvmDefault({ runId: 'vm-1' });
    await openPreviewTool.handler({ port: 3000 }, ctx);
    mockMicrovmSend.mockClear();

    const res = await openPreviewTool.handler({ port: 3000 }, ctx);
    expect(res).toContain('already active');
    expect(findCmds(mockMicrovmSend, 'Run')).toHaveLength(0);
  });

  test('newly-created MicroVM whose tunnel fails => MicroVM is terminated', async () => {
    ddbDefault(undefined);
    microvmDefault({ runId: 'vm-badtunnel' });
    tunnelConnectImpl.fn = async () => {
      throw new Error('nonretryable boom');
    };

    const res = await openPreviewTool.handler({ port: 3000 }, ctx);
    expect(res).toContain('Error in openPreview');
    // Created-in-this-call MicroVM must be terminated on failure.
    expect(findCmds(mockMicrovmSend, 'Terminate')).toHaveLength(1);
    expect(findCmds(mockMicrovmSend, 'Terminate')[0].input.microvmIdentifier).toBe('vm-badtunnel');
  });

  test('reused MicroVM whose tunnel fails => MicroVM is NOT terminated (kept for retry)', async () => {
    ddbDefault({ microvmId: 'vm-reuse', endpoint: 'stored', localPort: 3000 });
    microvmDefault({ getState: 'RUNNING' });
    tunnelConnectImpl.fn = async () => {
      throw new Error('nonretryable boom');
    };

    const res = await openPreviewTool.handler({ port: 3000 }, ctx);
    expect(res).toContain('Error in openPreview');
    // Adopted MicroVM must be left intact.
    expect(findCmds(mockMicrovmSend, 'Terminate')).toHaveLength(0);
  });
});

describe('terminate vs detach semantics', () => {
  test('terminatePreview (closePreview / kill-timer path) DOES terminate the MicroVM', async () => {
    // Set up an active preview first.
    ddbDefault(undefined);
    microvmDefault({ runId: 'vm-live' });
    await openPreviewTool.handler({ port: 3000 }, ctx);
    const tunnel = tunnelInstances[tunnelInstances.length - 1];
    mockMicrovmSend.mockClear();
    mockDdbSend.mockClear();
    ddbDefault(undefined);
    microvmDefault({});

    const res = await terminatePreview(WORKER_ID);

    expect(res).toContain('terminated');
    // MicroVM terminated + token deleted + tunnel closed.
    expect(findCmds(mockMicrovmSend, 'Terminate')).toHaveLength(1);
    expect(findCmds(mockMicrovmSend, 'Terminate')[0].input.microvmIdentifier).toBe('vm-live');
    expect(findCmds(mockDdbSend, 'Delete')).toHaveLength(1);
    expect(tunnel.close).toHaveBeenCalled();
  });

  test('detachPreview (process-exit path) does NOT terminate the MicroVM or touch DDB', async () => {
    ddbDefault(undefined);
    microvmDefault({ runId: 'vm-live' });
    await openPreviewTool.handler({ port: 3000 }, ctx);
    const tunnel = tunnelInstances[tunnelInstances.length - 1];
    mockMicrovmSend.mockClear();
    mockDdbSend.mockClear();

    detachPreview();

    // No MicroVM terminate, no DDB delete: state left for the successor to adopt.
    expect(findCmds(mockMicrovmSend, 'Terminate')).toHaveLength(0);
    expect(findCmds(mockDdbSend, 'Delete')).toHaveLength(0);
    // Local socket closed gracefully.
    expect(tunnel.close).toHaveBeenCalled();
  });

  test('after detach, a new adopt can re-attach the same MicroVM (respawn cycle)', async () => {
    // 1) open (create) then detach (simulate SIGTERM respawn).
    ddbDefault(undefined);
    microvmDefault({ runId: 'vm-cycle' });
    await openPreviewTool.handler({ port: 5000 }, ctx);
    detachPreview();

    // 2) successor process: DDB still has the record (localPort persisted), VM alive.
    tunnelInstances.length = 0;
    ddbDefault({ microvmId: 'vm-cycle', endpoint: 'stored', localPort: 5000 });
    microvmDefault({ getState: 'RUNNING' });

    const adopted = await adoptPreview(WORKER_ID);
    expect(adopted).not.toBeNull();
    expect(adopted!.microvmId).toBe('vm-cycle');
    expect(tunnelInstances).toHaveLength(1);
    expect(tunnelInstances[0].localPort).toBe(5000);
    expect(findCmds(mockMicrovmSend, 'Terminate')).toHaveLength(0);
  });
});

// Activation must be mutually exclusive across adopt + openPreview so two
// concurrent activations cannot both pass the `activePreview === null` check,
// double-install activePreview and leak the loser's token-refresh timer.
describe('activation mutex (concurrency)', () => {
  // Gate the tunnel connect on a manually-released promise so we can force two
  // activations to be in flight at the same time.
  function gateTunnelConnect() {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    tunnelConnectImpl.fn = () => gate;
    return () => release();
  }

  test('adopt in flight + concurrent openPreview => exactly ONE activation, one timer, one tunnel', async () => {
    // Adopt sees a live persisted MicroVM; openPreview would otherwise reuse it too.
    ddbDefault({ microvmId: 'vm-shared', endpoint: 'stored', localPort: 5173 });
    microvmDefault({ getState: 'RUNNING' });
    const release = gateTunnelConnect();

    // Start eager adopt (acquires the lock and blocks inside activatePreview on
    // the gated tunnel connect), then fire openPreview while adopt is in flight.
    const adoptP = adoptPreview(WORKER_ID);
    await Promise.resolve(); // let adopt reach the tunnel connect
    const openP = openPreviewTool.handler({ port: 5173 }, ctx);

    // Release the gate so the first activation to hold the lock completes; the
    // other then acquires the lock, re-checks activePreview and bails.
    release();
    const [adopted, openRes] = await Promise.all([adoptP, openP]);

    // Exactly ONE activation happened — order between adopt and openPreview is
    // not deterministic, but the mutex guarantees the loser stands down.
    const adoptWon = adopted !== null;
    if (adoptWon) {
      expect(openRes).toContain('already active');
    } else {
      expect(openRes).toContain('opened successfully');
    }
    // Exactly one tunnel was ever created (no leaked second tunnel/timer).
    expect(tunnelInstances).toHaveLength(1);
    // Neither path created a new MicroVM (both would reuse the live vm-shared).
    expect(findCmds(mockMicrovmSend, 'Run')).toHaveLength(0);
  });

  test('two concurrent openPreview calls => only one creates a MicroVM, the other reports already-active', async () => {
    ddbDefault(undefined); // no existing state => create path
    microvmDefault({ runId: 'vm-race' });
    const release = gateTunnelConnect();

    const p1 = openPreviewTool.handler({ port: 3000 }, ctx);
    await Promise.resolve();
    const p2 = openPreviewTool.handler({ port: 3000 }, ctx);

    release();
    const [r1, r2] = await Promise.all([p1, p2]);

    const results = [String(r1), String(r2)];
    const successes = results.filter((r) => r.includes('opened successfully'));
    const rejects = results.filter((r) => r.includes('already active'));
    expect(successes).toHaveLength(1);
    expect(rejects).toHaveLength(1);
    // Exactly one MicroVM created, one tunnel established.
    expect(findCmds(mockMicrovmSend, 'Run')).toHaveLength(1);
    expect(tunnelInstances).toHaveLength(1);
  });
});
