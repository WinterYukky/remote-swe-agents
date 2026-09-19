import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib.js';
import {
  LambdaMicrovmsClient,
  RunMicrovmCommand,
  CreateMicrovmAuthTokenCommand,
  TerminateMicrovmCommand,
  GetMicrovmCommand,
} from '@aws-sdk/client-lambda-microvms';
import { PutCommand, DeleteCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from '../../lib/aws/ddb.js';
import { writeMetadata } from '../../lib/metadata.js';
import { sendWebappEvent } from '../../lib/events.js';
import { TunnelClient } from './tunnel-client.js';
import { getWebappOrigin } from '../../lib/webapp-origin.js';

const microvmsClient = new LambdaMicrovmsClient({});

const TUNNEL_PORT = 9000;
const PROXY_PORT = 8080;
const TOKEN_REFRESH_INTERVAL_MS = 45 * 60 * 1000; // 45 minutes
const TOKEN_EXPIRATION_MINUTES = 60;
const PREVIEW_TOKEN_PK_PREFIX = 'preview-token';

export const PREVIEW_METADATA_TAG = 'previewSession';

export type PreviewSessionMetadata = {
  microvmId: string;
  microvmEndpoint: string;
  previewUrl: string;
  localPort: number;
  startedAt: number;
};

let activePreview: {
  microvmId: string;
  microvmEndpoint: string;
  tunnelClient: TunnelClient;
  tokenRefreshTimer: NodeJS.Timeout;
  localPort: number;
  workerId: string;
} | null = null;

const getMicrovmImageArn = (): string => {
  const arn = process.env.PREVIEW_MICROVM_IMAGE_ARN;
  if (!arn) {
    throw new Error('PREVIEW_MICROVM_IMAGE_ARN is not set.');
  }
  return arn;
};

// Generate webapp handoff URL (Cognito-authenticated redirect to preview)
async function getPreviewHandoffUrl(workerId: string): Promise<string> {
  const webappOrigin = await getWebappOrigin();
  if (!webappOrigin) {
    throw new Error('WEBAPP_ORIGIN_NAME_PARAMETER is not configured');
  }
  return `${webappOrigin}/api/preview/handoff/${workerId}`;
}

async function storePreviewToken(
  workerId: string,
  microvmId: string,
  endpoint: string,
  token: string,
  localPort: number
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName,
      Item: {
        PK: `${PREVIEW_TOKEN_PK_PREFIX}-${workerId}`,
        SK: 'current',
        microvmId,
        endpoint,
        token,
        // Persisted so a successor MCP subprocess can adopt (re-tunnel) the
        // MicroVM to the same local port after a kiro-cli respawn.
        localPort,
        updatedAt: Date.now(),
        TTL: Math.floor(Date.now() / 1000) + 7200, // S4: use 'TTL' (matches DDB table definition)
      },
    })
  );
}

async function deletePreviewToken(workerId: string): Promise<void> {
  await ddb.send(
    new DeleteCommand({
      TableName,
      Key: {
        PK: `${PREVIEW_TOKEN_PK_PREFIX}-${workerId}`,
        SK: 'current',
      },
    })
  );
}

// S6: Scoped token for browser traffic (port 8080 only)
async function createBrowserAuthToken(microvmId: string): Promise<string> {
  const resp = await microvmsClient.send(
    new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: microvmId,
      expirationInMinutes: TOKEN_EXPIRATION_MINUTES,
      allowedPorts: [{ port: PROXY_PORT }],
    })
  );

  const token = resp.authToken?.['X-aws-proxy-auth'];
  if (!token) {
    throw new Error('Failed to create MicroVM auth token: no token in response');
  }
  return token;
}

// S6: Scoped token for tunnel traffic (port 9000 only)
async function createTunnelAuthToken(microvmId: string): Promise<string> {
  const resp = await microvmsClient.send(
    new CreateMicrovmAuthTokenCommand({
      microvmIdentifier: microvmId,
      expirationInMinutes: TOKEN_EXPIRATION_MINUTES,
      allowedPorts: [{ port: TUNNEL_PORT }],
    })
  );

  const token = resp.authToken?.['X-aws-proxy-auth'];
  if (!token) {
    throw new Error('Failed to create MicroVM tunnel auth token: no token in response');
  }
  return token;
}

async function notifyPreviewUpdate(workerId: string, metadata: PreviewSessionMetadata | null): Promise<void> {
  try {
    await sendWebappEvent(workerId, {
      type: 'portsUpdate',
      hostname: metadata?.previewUrl,
      openedPorts: metadata
        ? [{ fromPort: metadata.localPort, toPort: metadata.localPort, cidr: '*', openedAt: metadata.startedAt }]
        : [],
    });
  } catch (e) {
    console.log(`Failed to notify preview update for ${workerId}: ${e}`);
  }
}

// S3: Check for existing preview state in DDB (crash recovery / adopt)
async function getExistingPreviewState(
  workerId: string
): Promise<{ microvmId: string; endpoint: string; localPort?: number } | null> {
  try {
    const result = await ddb.send(
      new GetCommand({
        TableName,
        Key: {
          PK: `${PREVIEW_TOKEN_PK_PREFIX}-${workerId}`,
          SK: 'current',
        },
      })
    );
    if (result.Item?.microvmId && result.Item?.endpoint) {
      return {
        microvmId: result.Item.microvmId,
        endpoint: result.Item.endpoint,
        localPort: typeof result.Item.localPort === 'number' ? result.Item.localPort : undefined,
      };
    }
  } catch {
    // ignore
  }
  return null;
}

// S3: Terminate orphaned MicroVM from previous crash
async function terminateOrphanedMicrovm(microvmId: string): Promise<void> {
  try {
    await microvmsClient.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
    console.log(`[preview] Terminated orphaned MicroVM ${microvmId}`);
  } catch (e: any) {
    if (!e.name?.includes('NotFound')) {
      console.error(`[preview] Failed to terminate orphaned MicroVM ${microvmId}:`, e.message);
    }
  }
}

// Adopt: probe a persisted MicroVM to decide whether it can be re-attached.
// Returns the (possibly refreshed) endpoint when the MicroVM is still alive,
// or null when it is gone (NotFound / terminated / auto-terminated after the
// suspended-duration expired). A null result means the caller must clean up
// the stale DDB record instead of adopting.
async function getLiveMicrovmEndpoint(microvmId: string): Promise<string | null> {
  try {
    const resp = await microvmsClient.send(new GetMicrovmCommand({ microvmIdentifier: microvmId }));
    // A terminated MicroVM cannot serve traffic; treat it as gone. The state
    // field is eventually consistent, so we only hard-reject the explicit
    // terminal states and otherwise trust the endpoint (auto-resume brings a
    // suspended VM back on the next request).
    // MicrovmState terminal values are TERMINATED / TERMINATING. SUSPENDED /
    // SUSPENDING / PENDING / RUNNING are all adoptable (auto-resume brings a
    // suspended VM back on the next request).
    const state = (resp.state ?? '').toUpperCase();
    if (resp.terminatedAt || state === 'TERMINATED' || state === 'TERMINATING') {
      return null;
    }
    return resp.endpoint ?? null;
  } catch (e: any) {
    if (e.name?.includes('NotFound') || e.name === 'ResourceNotFoundException') {
      return null;
    }
    // Unknown/transient error — surface to caller so it does not silently
    // discard a MicroVM that may still be alive.
    throw e;
  }
}

// --- openPreview ---

const openPreviewInputSchema = z.object({
  port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .describe('The local port where the dev server is running (e.g. 3000 for Next.js, 5173 for Vite).'),
});

const openPreviewName = 'open_preview';

// Establish the WebSocket tunnel to an already-running MicroVM (fresh or
// adopted), (re)issue the browser token, wire up the refresh timer and set
// activePreview + metadata. Shared by openPreview (new MicroVM) and
// adoptPreview (existing MicroVM after a kiro-cli respawn). Throws on failure;
// the caller owns MicroVM teardown/cleanup decisions.
async function activatePreview(params: {
  workerId: string;
  microvmId: string;
  endpoint: string;
  port: number;
}): Promise<PreviewSessionMetadata> {
  const { workerId, microvmId, endpoint, port } = params;

  // Scoped auth tokens (S6): tunnel (worker→MicroVM) + browser (viewer→MicroVM).
  const browserToken = await createBrowserAuthToken(microvmId);
  const tunnelToken = await createTunnelAuthToken(microvmId);

  // Persist the browser token (+ localPort) so L@E can authenticate viewer
  // traffic and a future successor can adopt.
  await storePreviewToken(workerId, microvmId, endpoint, browserToken, port);

  // Establish WebSocket tunnel to MicroVM (with retry for boot / auto-resume race)
  const MAX_TUNNEL_CONNECT_RETRIES = 5;
  const INITIAL_TUNNEL_RETRY_DELAY_MS = 2000;
  let tunnelClient: TunnelClient | undefined;
  let tunnelConnectError: Error | undefined;
  for (let attempt = 0; attempt < MAX_TUNNEL_CONNECT_RETRIES; attempt++) {
    const client = new TunnelClient(endpoint, TUNNEL_PORT, port, tunnelToken, () => {
      console.log(`[preview] Tunnel disconnected for worker ${workerId}, scheduling reconnect`);
      scheduleReconnect(workerId);
    });
    try {
      await client.connect();
      tunnelClient = client;
      tunnelConnectError = undefined;
      break;
    } catch (e: any) {
      client.terminate();
      tunnelConnectError = e;
      const errMsg = (e.message ?? '').toLowerCase();
      const isRetryable =
        errMsg.includes('timeout') ||
        errMsg.includes('econnrefused') ||
        errMsg.includes('econnreset') ||
        errMsg.includes('etimedout') ||
        errMsg.includes('502') ||
        errMsg.includes('503');
      if (!isRetryable || attempt >= MAX_TUNNEL_CONNECT_RETRIES - 1) {
        break;
      }
      const delay = INITIAL_TUNNEL_RETRY_DELAY_MS * Math.pow(2, attempt);
      console.log(`[preview] Tunnel connect attempt ${attempt + 1} failed (${e.message}), retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  if (tunnelConnectError || !tunnelClient) {
    // The tunnel connect retry loop already terminate()'d every failed
    // client, and no timer / activePreview has been created yet, so there is
    // nothing to leak here. Crucially we do NOT touch a pre-existing
    // activePreview (a concurrent activation): activatePreview is atomic and
    // only mutates global state on success (see the try/catch below).
    throw tunnelConnectError ?? new Error('Tunnel connection failed');
  }
  const connectedTunnel = tunnelClient;

  // From here on we may create a timer and assign activePreview. Wrap the
  // remainder so that if ANY step throws we clean up OUR OWN partial resources
  // (timer + tunnel) and only clear activePreview if it is still the object we
  // installed — never a healthy preview installed by a concurrent activation.
  let tokenRefreshTimer: NodeJS.Timeout | undefined;
  let installedState: typeof activePreview = null;
  try {
    // Token refresh timer (S5: atomic refresh). localPort is stable for the
    // session, so re-persist with the same port on every refresh.
    tokenRefreshTimer = setInterval(async () => {
      try {
        const newBrowserToken = await createBrowserAuthToken(microvmId);
        await storePreviewToken(workerId, microvmId, endpoint, newBrowserToken, port);

        const newTunnelToken = await createTunnelAuthToken(microvmId);
        // S5: updateAuthToken handles atomic WS replacement (old connection kept until new is ready)
        connectedTunnel.updateAuthToken(newTunnelToken);
        console.log(`[preview] Tokens refreshed for ${workerId}`);
      } catch (e) {
        console.error(`[preview] Token refresh failed for ${workerId}:`, e);
      }
    }, TOKEN_REFRESH_INTERVAL_MS);

    installedState = {
      microvmId,
      microvmEndpoint: endpoint,
      tunnelClient: connectedTunnel,
      tokenRefreshTimer,
      localPort: port,
      workerId,
    };
    activePreview = installedState;

    // The preview URL is a workerId-based handoff URL, so it is stable
    // across adopt — the user's existing browser tab keeps working.
    const previewUrl = await getPreviewHandoffUrl(workerId);
    const metadata: PreviewSessionMetadata = {
      microvmId,
      microvmEndpoint: endpoint,
      previewUrl,
      localPort: port,
      startedAt: Date.now(),
    };
    await writeMetadata(PREVIEW_METADATA_TAG, metadata, workerId);
    await notifyPreviewUpdate(workerId, metadata);

    return metadata;
  } catch (e) {
    // Self-cleaning: tear down only OUR resources. Identity check guards
    // against clobbering a concurrent activation's healthy state.
    if (tokenRefreshTimer) clearInterval(tokenRefreshTimer);
    connectedTunnel.close();
    if (activePreview === installedState) activePreview = null;
    throw e;
  }
}

// Serialize preview activation. Eager adopt (runStdioServer) and openPreview
// both check `activePreview === null` then call activatePreview; without a lock
// they can interleave (a SUSPENDED VM's auto-resume + tunnel retry can take tens
// of seconds), double-installing activePreview and leaking the loser's timer.
// This promise-chain mutex makes the "re-check activePreview then activate"
// critical section mutually exclusive across the whole module.
let activationLock: Promise<void> = Promise.resolve();
async function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
  const prev = activationLock;
  let release!: () => void;
  activationLock = new Promise<void>((r) => (release = r));
  try {
    await prev.catch(() => {});
    return await fn();
  } finally {
    release();
  }
}

// Run a brand-new MicroVM and return its identifiers.
async function runNewMicrovm(): Promise<{ microvmId: string; endpoint: string }> {
  const imageArn = getMicrovmImageArn();
  const runResp = await microvmsClient.send(
    new RunMicrovmCommand({
      imageIdentifier: imageArn,
      ingressNetworkConnectors: [
        `arn:aws:lambda:${process.env.AWS_REGION}:aws:network-connector:aws-network-connector:ALL_INGRESS`,
      ],
      egressNetworkConnectors: [
        `arn:aws:lambda:${process.env.AWS_REGION}:aws:network-connector:aws-network-connector:INTERNET_EGRESS`,
      ],
      idlePolicy: {
        autoResumeEnabled: true,
        maxIdleDurationSeconds: 900,
        suspendedDurationSeconds: 3600,
      },
      maximumDurationInSeconds: 28800,
    })
  );
  const microvmId = runResp.microvmId;
  const endpoint = runResp.endpoint;
  if (!microvmId || !endpoint) {
    throw new Error('RunMicrovm returned no microvmId or endpoint');
  }
  return { microvmId, endpoint };
}

const openPreviewSuccessMessage = (port: number, microvmId: string, previewUrl: string): string =>
  [
    `Preview opened successfully.`,
    `- Local port: ${port}`,
    `- MicroVM ID: ${microvmId}`,
    `- Preview URL: ${previewUrl}`,
    ``,
    `IMPORTANT: Share the Preview URL above with the user. NEVER tell them to open localhost:${port} or 127.0.0.1:${port} — those are unreachable from their browser.`,
    `The webapp automatically converts localhost:${port} mentions in your messages into clickable preview links, but always prefer giving the Preview URL directly.`,
    `Only one preview can be active in the user's browser at a time.`,
    `The preview will auto-suspend after 15 minutes of inactivity.`,
    `Use close_preview to terminate when done.`,
  ].join('\n');

// Adopt a MicroVM persisted in DDB by a previous MCP subprocess (kiro-cli
// respawn recovery). Re-attaches the tunnel to the same local port using the
// stored state so the preview auto-recovers on the next turn without the agent
// re-calling openPreview. If the MicroVM is gone (auto-terminated / NotFound)
// the stale DDB + metadata are cleaned up and null is returned.
//
// Best-effort and idempotent: does nothing if a preview is already active in
// this process, if not on agent-core runtime, or if no persisted state exists.
export const adoptPreview = async (workerId: string): Promise<PreviewSessionMetadata | null> => {
  if (activePreview) return null;
  if (process.env.WORKER_RUNTIME !== 'agent-core') return null;
  if (!process.env.PREVIEW_MICROVM_IMAGE_ARN) return null;

  const existing = await getExistingPreviewState(workerId);
  if (!existing) return null;

  // Without a persisted localPort we cannot re-tunnel (older records predate
  // this field). Treat as unadoptable and clean up.
  if (typeof existing.localPort !== 'number') {
    console.log(`[preview] Cannot adopt ${existing.microvmId} for ${workerId}: no persisted localPort. Cleaning up.`);
    await cleanupStalePreview(workerId, existing.microvmId);
    return null;
  }
  const port = existing.localPort;

  let liveEndpoint: string | null;
  try {
    liveEndpoint = await getLiveMicrovmEndpoint(existing.microvmId);
  } catch (e: any) {
    // Transient GetMicrovm error: do NOT destroy state; leave it for a later
    // adopt/openPreview attempt.
    console.error(
      `[preview] Adopt probe failed for ${workerId} (${existing.microvmId}): ${e.message}. Leaving state intact.`
    );
    return null;
  }

  if (!liveEndpoint) {
    console.log(`[preview] Persisted MicroVM ${existing.microvmId} for ${workerId} is gone; cleaning up.`);
    await cleanupStalePreview(workerId, existing.microvmId);
    return null;
  }
  const endpoint = liveEndpoint;

  // Acquire the activation lock, then re-check activePreview. A concurrent
  // openPreview may have activated a preview while we were probing — if so,
  // stand down (do NOT double-activate / clobber it).
  return runExclusive(async () => {
    if (activePreview) {
      console.log(`[preview] Skipping adopt for ${workerId}: a preview became active concurrently.`);
      return null;
    }
    try {
      const metadata = await activatePreview({ workerId, microvmId: existing.microvmId, endpoint, port });
      console.log(`[preview] Adopted MicroVM ${existing.microvmId} for ${workerId} on port ${port}`);
      return metadata;
    } catch (e: any) {
      // activatePreview is atomic: on failure it has already torn down its own
      // timer/tunnel and left any other activePreview untouched. Keep the
      // MicroVM + DDB state so a later attempt (auto-resume settle) can retry.
      console.error(`[preview] Failed to adopt MicroVM ${existing.microvmId} for ${workerId}: ${e.message}`);
      return null;
    }
  });
};

// Remove a stale/dead persisted preview: best-effort MicroVM terminate + DDB
// delete + clear metadata/notify. Used when adopt determines the MicroVM is gone.
async function cleanupStalePreview(workerId: string, microvmId: string): Promise<void> {
  await terminateOrphanedMicrovm(microvmId);
  try {
    await deletePreviewToken(workerId);
  } catch (e: any) {
    console.error(`[preview] Failed to delete stale preview token for ${workerId}:`, e.message);
  }
  try {
    await writeMetadata(PREVIEW_METADATA_TAG, { previewUrl: null, localPort: null }, workerId);
    await notifyPreviewUpdate(workerId, null);
  } catch (e: any) {
    console.error(`[preview] Failed to clear stale preview metadata for ${workerId}:`, e.message);
  }
}

export const openPreviewTool: ToolDefinition<z.infer<typeof openPreviewInputSchema>> = {
  name: openPreviewName,
  handler: async (input, context) => {
    const { workerId } = context;
    const { port } = input;

    // S3: fast-path reject. The authoritative check is re-done inside the
    // activation lock below (a concurrent eager adopt may still be in flight).
    if (activePreview) {
      return `Error: A preview session is already active (port ${activePreview.localPort}). Close it with close_preview first.`;
    }

    if (process.env.WORKER_RUNTIME !== 'agent-core') {
      return 'Error: open_preview is only available on AgentCore runtime.';
    }

    // Serialize with any in-flight eager adopt. Everything that inspects or
    // mutates activePreview (the re-check, adopt-or-create, activatePreview)
    // runs inside the lock so it cannot interleave with adoptPreview.
    return runExclusive(async () => {
      // Authoritative re-check: an eager adopt may have activated a preview
      // while we waited for the lock.
      if (activePreview) {
        return `Error: A preview session is already active (port ${activePreview.localPort}). Close it with close_preview first.`;
      }

      // Adopt-or-create: if a previous MCP subprocess left a live MicroVM in
      // DDB, reuse it (same MicroVM = same preview URL) rather than terminating
      // and recreating. Reuse honours the port requested in THIS call.
      const existing = await getExistingPreviewState(workerId);
      let reuse: { microvmId: string; endpoint: string } | null = null;
      if (existing) {
        let liveEndpoint: string | null = null;
        try {
          liveEndpoint = await getLiveMicrovmEndpoint(existing.microvmId);
        } catch (e: any) {
          // Transient probe failure: we optimistically reuse the recorded
          // endpoint. NOTE: if that reused MicroVM is actually unreachable the
          // tunnel connect below exhausts its retries and this call returns an
          // error — it does NOT fall back to creating a new MicroVM (the
          // recorded MicroVM is left intact for a later retry). A subsequent
          // openPreview whose probe returns a definitive "gone" will then clean
          // up and recreate.
          console.error(
            `[preview] openPreview probe failed for ${existing.microvmId}: ${e.message}. Attempting reuse anyway.`
          );
          liveEndpoint = existing.endpoint;
        }
        if (liveEndpoint) {
          reuse = { microvmId: existing.microvmId, endpoint: liveEndpoint };
        } else {
          // Dead/orphaned MicroVM from a previous crash: clean up before recreate.
          await terminateOrphanedMicrovm(existing.microvmId);
          await deletePreviewToken(workerId);
        }
      }

      let microvmId: string | undefined;
      let createdNew = false;
      try {
        let endpoint: string;
        if (reuse) {
          microvmId = reuse.microvmId;
          endpoint = reuse.endpoint;
        } else {
          const created = await runNewMicrovm();
          microvmId = created.microvmId;
          endpoint = created.endpoint;
          createdNew = true;
        }

        // activatePreview is atomic: on failure it tears down its own
        // timer/tunnel and leaves global activePreview untouched, so there is
        // no cross-detach hazard and nothing local to clean up here.
        const metadata = await activatePreview({ workerId, microvmId, endpoint, port });
        return openPreviewSuccessMessage(port, microvmId, metadata.previewUrl);
      } catch (e: any) {
        // Only terminate the MicroVM if WE created it in this call. A reused
        // (adopted) MicroVM whose tunnel failed to connect is left intact so a
        // later attempt can retry — matching the adopt path's fail-safe.
        if (createdNew && microvmId) {
          try {
            await microvmsClient.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
          } catch {} // best effort
          try {
            await deletePreviewToken(workerId);
          } catch {} // best effort
        }
        return `Error in openPreview: ${e.name ?? 'Error'}: ${e.message}`;
      }
    });
  },
  schema: openPreviewInputSchema,
  toolSpec: async () => ({
    name: openPreviewName,
    description: `Open a public preview of a locally running dev server by establishing a tunnel through a Lambda MicroVM.

This creates a MicroVM that acts as a reverse proxy, establishing a WebSocket tunnel from this worker to the MicroVM. Browser traffic from the preview URL is forwarded through the tunnel to your local dev server.

The preview URL is protected by authentication via a handoff token. HMR/WebSocket connections are supported for hot-reload development workflows.

Requirements:
- A dev server must already be running on the specified port
- Only one preview session can be active at a time
- Only available on AgentCore runtime (not EC2)

The preview will auto-suspend after 15 minutes of idle and auto-terminate after 1 hour suspended. Use close_preview to terminate early.

This is the ONLY way to expose a local port to the user's browser. Do NOT use localtunnel, ngrok, or any other external tunneling service.`,
    inputSchema: {
      json: zodToJsonSchemaBody(openPreviewInputSchema),
    },
  }),
};

// S2: Reconnection logic — on-demand only (should-fix 5: avoid ingress that prevents idle suspend)
// Instead of eagerly reconnecting (which prevents MicroVM from suspending), we mark the tunnel
// as disconnected. The MicroVM will auto-resume on the next browser request (via CF → MicroVM ingress).
// The proxy inside MicroVM will return 502 until the worker reconnects.
// Reconnection is triggered lazily: the worker polls or is notified.
const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_DELAY_MS = 30_000; // 30s delay to allow suspend to settle

function scheduleReconnect(workerId: string) {
  if (!activePreview || activePreview.workerId !== workerId) return;

  let attempt = 0;

  const onPermanentFailure = async () => {
    if (!activePreview || activePreview.workerId !== workerId) return;
    console.error(`[preview] Reconnect permanently failed for ${workerId}. Full cleanup.`);
    clearInterval(activePreview.tokenRefreshTimer);
    activePreview.tunnelClient.close();
    const { microvmId } = activePreview;
    activePreview = null;
    try {
      await microvmsClient.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
    } catch (e: any) {
      if (!e.name?.includes('NotFound')) {
        console.error(`[preview] Failed to terminate MicroVM ${microvmId}:`, e.message);
      }
    }
    try {
      await deletePreviewToken(workerId);
    } catch (e: any) {
      console.error(`[preview] Failed to delete preview token:`, e.message);
    }
    try {
      await writeMetadata(PREVIEW_METADATA_TAG, { previewUrl: null, localPort: null }, workerId);
      await notifyPreviewUpdate(workerId, null);
    } catch (e: any) {
      console.error(`[preview] Failed to clear metadata:`, e.message);
    }
  };

  const tryReconnect = () => {
    if (!activePreview || activePreview.workerId !== workerId) return;
    attempt++;

    if (attempt > MAX_RECONNECT_ATTEMPTS) {
      onPermanentFailure().catch((e) => console.error('[preview] Unexpected error in onPermanentFailure:', e));
      return;
    }

    // Use longer delay to avoid preventing idle suspend
    const delay = RECONNECT_DELAY_MS * attempt;
    console.log(`[preview] Reconnect attempt ${attempt} in ${delay}ms for ${workerId}`);

    setTimeout(async () => {
      if (!activePreview || activePreview.workerId !== workerId) return;

      try {
        const newTunnelToken = await createTunnelAuthToken(activePreview.microvmId);
        const tunnelClient = new TunnelClient(
          activePreview.microvmEndpoint,
          TUNNEL_PORT,
          activePreview.localPort,
          newTunnelToken,
          () => {
            console.log(`[preview] Tunnel disconnected again for ${workerId}`);
            scheduleReconnect(workerId);
          }
        );

        await tunnelClient.connect();
        activePreview.tunnelClient = tunnelClient;
        console.log(`[preview] Reconnected successfully for ${workerId}`);
      } catch (e: any) {
        console.error(`[preview] Reconnect attempt ${attempt} failed: ${e.message}`);
        tryReconnect();
      }
    }, delay);
  };

  tryReconnect();
}

// Tear down only the LOCAL, in-process resources of the active preview (token
// refresh timer + tunnel WebSocket) WITHOUT terminating the MicroVM or touching
// DDB/metadata. The MicroVM and its DDB `preview-token` record are deliberately
// left alive so the successor MCP subprocess (spawned with the next kiro-cli)
// can adopt (re-tunnel) it. Idempotent.
export function detachPreview(): void {
  if (!activePreview) return;
  const { tokenRefreshTimer, tunnelClient, workerId, microvmId } = activePreview;
  clearInterval(tokenRefreshTimer);
  // close() (graceful) rather than terminate(): the WS is going away because
  // THIS process is exiting; the MicroVM stays up for the successor.
  tunnelClient.close();
  activePreview = null;
  console.log(`[preview] Detached preview for ${workerId} (MicroVM ${microvmId} left alive for adopt)`);
}

// should-fix 6: Explicit initialization (no import side-effect), no process.exit forcing
let exitHandlersRegistered = false;
let cleanupInProgress = false;

export function registerPreviewExitHandlers(): void {
  if (exitHandlersRegistered) return;
  exitHandlersRegistered = true;

  // CRITICAL: process exit here is (almost always) a kiro-cli SIGTERM respawn,
  // NOT a real teardown. The MCP subprocess shares its lifetime 1:1 with the
  // kiro-cli subprocess (see packages/worker/src/agent/kiro-mcp-servers.ts),
  // and kiro-cli is SIGTERM'd whenever the current converse session is
  // cancelled (e.g. the next user message arrives mid-turn). Terminating the
  // MicroVM on exit would kill the preview on every respawn. Instead we DETACH
  // (local cleanup only) and leave the MicroVM + DDB state for the successor to
  // adopt. Real teardown (MicroVM terminate) happens via terminatePreview(),
  // which is called by closePreview, the worker kill-timer (true sleep), and
  // (confirm)completeSession.
  const cleanup = () => {
    if (cleanupInProgress) return;
    cleanupInProgress = true;
    if (activePreview) {
      console.log(`[preview] Process exiting, detaching preview for ${activePreview.workerId} (MicroVM kept alive)`);
      try {
        detachPreview();
      } catch (e: any) {
        console.error(`[preview] Detach on exit failed: ${e.message}`);
      }
    }
    cleanupInProgress = false;
  };

  const sigHandler = (sig: NodeJS.Signals) => {
    cleanup();
    process.removeListener('SIGTERM', sigHandler);
    process.removeListener('SIGINT', sigHandler);
    process.kill(process.pid, sig);
  };
  process.on('SIGTERM', sigHandler);
  process.on('SIGINT', sigHandler);
  process.on('beforeExit', () => {
    cleanup();
  });
}

// --- closePreview ---

const closePreviewInputSchema = z.object({});

const closePreviewName = 'close_preview';

export const terminatePreview = async (workerId: string): Promise<string> => {
  if (!activePreview) {
    // S3: Check DDB for orphaned state even if activePreview is null
    const existing = await getExistingPreviewState(workerId);
    if (existing) {
      await terminateOrphanedMicrovm(existing.microvmId);
      await deletePreviewToken(workerId);
      await writeMetadata(PREVIEW_METADATA_TAG, { previewUrl: null, localPort: null }, workerId);
      await notifyPreviewUpdate(workerId, null);
      return `Cleaned up orphaned preview. MicroVM ${existing.microvmId} terminated.`;
    }
    return 'No active preview session to close.';
  }

  const { microvmId, tunnelClient, tokenRefreshTimer } = activePreview;

  clearInterval(tokenRefreshTimer);
  tunnelClient.close();

  try {
    await microvmsClient.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
  } catch (e: any) {
    console.error(`[preview] Failed to terminate MicroVM ${microvmId}:`, e.message);
  }

  try {
    await deletePreviewToken(workerId);
  } catch (e: any) {
    console.error(`[preview] Failed to delete preview token for ${workerId}:`, e.message);
  }

  try {
    await writeMetadata(PREVIEW_METADATA_TAG, { previewUrl: null, localPort: null }, workerId);
    await notifyPreviewUpdate(workerId, null);
  } catch (e: any) {
    console.error(`[preview] Failed to clear preview metadata for ${workerId}:`, e.message);
  }

  activePreview = null;

  return `Preview closed. MicroVM ${microvmId} terminated.`;
};

export const closePreviewTool: ToolDefinition<z.infer<typeof closePreviewInputSchema>> = {
  name: closePreviewName,
  handler: async (_input, context) => {
    try {
      return await terminatePreview(context.workerId);
    } catch (e: any) {
      return `Error in closePreview: ${e.name ?? 'Error'}: ${e.message}`;
    }
  },
  schema: closePreviewInputSchema,
  toolSpec: async () => ({
    name: closePreviewName,
    description: 'Close the active preview session by terminating the MicroVM tunnel and releasing all resources.',
    inputSchema: {
      json: zodToJsonSchemaBody(closePreviewInputSchema),
    },
  }),
};
