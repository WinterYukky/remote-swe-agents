import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { ddb, TableName } from './aws/ddb';

/**
 * Persist a webapp client's source IP for a worker session so the
 * `openPort` tool can auto-derive a /32 CIDR on later turns without the
 * IP ever being attached to a `MessageItem` (which would retain it as
 * PII for the full lifetime of the messages table).
 *
 * # Why a separate, short-lived DDB row?
 * - `openPort` is an EC2-only feature, but EC2 workers can stop and
 *   resume — so a purely process-local in-memory cache loses the IP on
 *   resume and forces the user to retype the CIDR every time the worker
 *   wakes up. A DDB row covers cold start, resume, and the very first
 *   turn of an AgentCore-runtime session uniformly.
 * - Putting the IP on every `MessageItem` (the prior design) caused the
 *   IP to be retained alongside the message body indefinitely. A
 *   dedicated row with a 1-hour TTL bounds the retention window to the
 *   period during which the user is plausibly still interacting with
 *   the same session.
 *
 * # Schema
 *   PK: `sender-ip-${workerId}`
 *   SK: `latest`
 *   ip: string                  — the source IP (IPv4 dotted-quad)
 *   TTL: number                 — Unix seconds (DynamoDB native TTL attr,
 *                                 see `cdk/lib/constructs/storage.ts`)
 *
 * The PK namespace (`sender-ip-`) is disjoint from `message-`,
 * `metadata-`, `sessions`, and the other PKs the rest of the table
 * uses, so this row never collides with conversation history reads.
 *
 * # TTL window
 * 1 hour. Long enough to cover a typical interactive session while
 * keeping the retention window explicitly bounded. DynamoDB's TTL
 * sweeper deletes the row asynchronously after the timestamp passes;
 * `getSenderIp` does not need to filter manually because reads of an
 * expired-but-not-yet-deleted row are still permitted (and harmless —
 * the IP becomes useless once the user's actual address rotates, which
 * is the same constraint the user was already living with under the
 * `MessageItem.senderIp` design).
 */
const SENDER_IP_TTL_SECONDS = 60 * 60; // 1 hour

const buildPk = (workerId: string) => `sender-ip-${workerId}`;
const SK = 'latest';

/**
 * Persist (or refresh) the sender IP for a session. Called from the
 * webapp/Slack/REST request paths immediately after a user message is
 * accepted, so subsequent `openPort` calls can pick the IP up via
 * `getSenderIp`.
 *
 * - No-op when `workerId` or `ip` is empty/undefined; this keeps the
 *   call sites cheap (`await setSenderIp(id, await getClientIp())`)
 *   without forcing every caller to gate on a truthy IP.
 * - Best-effort error handling is the caller's responsibility — this
 *   function lets exceptions bubble so test mocks can assert on calls,
 *   but production callers should swallow errors so a transient DDB
 *   failure cannot block the user's actual message turn.
 */
export const setSenderIp = async (workerId: string, ip: string | undefined): Promise<void> => {
  if (!workerId || !ip) return;
  await ddb.send(
    new PutCommand({
      TableName,
      Item: {
        PK: buildPk(workerId),
        SK,
        ip,
        TTL: Math.floor(Date.now() / 1000) + SENDER_IP_TTL_SECONDS,
      },
    })
  );
};

/**
 * Retrieve the most recently persisted sender IP for a session, or
 * `undefined` if nothing was stored (or the row was already swept by
 * DynamoDB's TTL machinery).
 *
 * Consumers should treat `undefined` as "no auto-detection possible —
 * ask the user for an explicit CIDR" rather than as an error; that is
 * how `openPort` handles a missing IP today, returning a friendly
 * error that asks the caller to pass `cidr` explicitly.
 */
export const getSenderIp = async (workerId: string): Promise<string | undefined> => {
  if (!workerId) return undefined;
  const res = await ddb.send(
    new GetCommand({
      TableName,
      Key: {
        PK: buildPk(workerId),
        SK,
      },
    })
  );
  const ip = res.Item?.ip;
  return typeof ip === 'string' && ip.length > 0 ? ip : undefined;
};
