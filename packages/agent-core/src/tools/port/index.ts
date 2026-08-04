import { z } from 'zod';
import { ToolDefinition, zodToJsonSchemaBody } from '../../private/common/lib';
import {
  EC2Client,
  AuthorizeSecurityGroupIngressCommand,
  RevokeSecurityGroupIngressCommand,
  DescribeSecurityGroupsCommand,
  IpPermission,
} from '@aws-sdk/client-ec2';
import { getSenderIp } from '../../lib/sender-ip';
import { readMetadata, writeMetadata } from '../../lib/metadata';
import { sendWebappEvent } from '../../lib/events';

const ec2 = new EC2Client();

const IPV4_CIDR_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/;
const IPV4_ADDRESS_REGEX = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;

/**
 * Minimum CIDR prefix length (i.e. "most permissive") allowed for openPort.
 * /24 == 256 addresses. Anything broader is rejected to prevent accidental
 * world-exposure of dev services.
 */
const MIN_CIDR_PREFIX_LENGTH = 24;

/**
 * SG ingress rules opened by this tool are tagged in the `Description` field
 * with this prefix + the workerId so `closePort` / `revokePortRules` can
 * identify and revoke only the rules it owns.
 *
 * NOTE (N1): The prefix stays as `preview:` rather than `port:` for backward
 * compatibility with rules created by the pre-rename `openPreview` /
 * `closePreview` tools. Changing it would orphan any live rules created
 * before this release. New sessions continue writing the same value, so
 * mixed old/new workers can coexist safely.
 */
const SG_RULE_DESCRIPTION_PREFIX = 'preview';

/**
 * Metadata key under `metadata-${workerId}` used to persist opened ports
 * and the EC2 public hostname so the webapp can rewrite localhost URLs
 * in messages to the public preview URL.
 */
export const OPENED_PORTS_METADATA_KEY = 'openedPorts';

export type OpenedPort = {
  fromPort: number;
  toPort: number;
  cidr: string;
  openedAt: number;
};

export type OpenedPortsMetadata = {
  hostname?: string;
  openedPorts: OpenedPort[];
};

/**
 * Serializes concurrent port operations within a single worker process so an
 * in-flight `openPort`/`closePort` cannot interleave with another one and
 * clobber the persisted `openedPorts` metadata. The agent loop is
 * single-threaded today, but tool dispatch is async — two rapid tool calls
 * could otherwise race on the read-modify-write cycle below.
 *
 * Memory note: each call REPLACES `portOperationQueue` with the new tail,
 * so the queue is a single-node microtask chain at any moment, not a
 * growing history of past operations. Completed operations are eligible
 * for GC as soon as callers release their handle.
 */
let portOperationQueue: Promise<unknown> = Promise.resolve();
const withPortLock = <T>(fn: () => Promise<T>): Promise<T> => {
  const next = portOperationQueue.then(fn, fn);
  // Swallow rejections on the queue itself so one failed op doesn't poison
  // every subsequent op with the previous error.
  portOperationQueue = next.catch(() => {});
  return next;
};

const getSecurityGroupId = () => {
  const sgId = process.env.SECURITY_GROUP_ID;
  if (!sgId) {
    throw new Error('SECURITY_GROUP_ID is not set. This tool is only available on EC2 runtime.');
  }
  return sgId;
};

const getImdsV2Token = async () => {
  const res = await fetch('http://169.254.169.254/latest/api/token', {
    method: 'PUT',
    headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '900' },
  });
  return await res.text();
};

const getPublicHostname = async () => {
  const token = await getImdsV2Token();
  const res = await fetch('http://169.254.169.254/latest/meta-data/public-hostname', {
    headers: { 'X-aws-ec2-metadata-token': token },
  });
  if (!res.ok) {
    throw new Error(`Failed to get public hostname from IMDS: ${res.status} ${res.statusText}`);
  }
  return await res.text();
};

/**
 * Fetch opened-ports metadata for the given worker, returning a normalized
 * empty shape when nothing has been persisted yet.
 */
const readOpenedPortsMetadata = async (workerId: string): Promise<OpenedPortsMetadata> => {
  const item = (await readMetadata(OPENED_PORTS_METADATA_KEY, workerId)) as OpenedPortsMetadata | undefined;
  if (!item) {
    return { openedPorts: [] };
  }
  return {
    hostname: item.hostname,
    openedPorts: Array.isArray(item.openedPorts) ? item.openedPorts : [],
  };
};

const writeOpenedPortsMetadata = async (workerId: string, data: OpenedPortsMetadata) => {
  await writeMetadata(OPENED_PORTS_METADATA_KEY, data, workerId);
};

/**
 * Best-effort webapp notification. `sendWebappEvent` already swallows its own
 * errors internally, but we still wrap it at the call site to guarantee a
 * notification failure never causes the tool invocation to fail.
 */
const notifyPortsUpdate = async (workerId: string, data: OpenedPortsMetadata) => {
  try {
    await sendWebappEvent(workerId, {
      type: 'portsUpdate',
      hostname: data.hostname,
      openedPorts: data.openedPorts,
    });
  } catch (e) {
    console.log(`Failed to notify portsUpdate for ${workerId}: ${e}`);
  }
};

/**
 * Merge a newly opened range into the persisted list, deduplicating so the
 * list stays minimal:
 *  - any existing range that is fully contained in the new range is dropped
 *    (the new, wider range supersedes the narrow one; e.g. adding 3000-3010
 *    absorbs a prior 3000-3000)
 *  - any existing range that is an exact match is replaced (refreshes
 *    openedAt and cidr)
 *  - partially overlapping ranges are kept alongside the new range because
 *    normalizing arbitrary overlaps is hairy and the UI is tolerant to it.
 */
const mergeRange = (existing: OpenedPort[], incoming: OpenedPort): OpenedPort[] => {
  const filtered = existing.filter((p) => !(p.fromPort >= incoming.fromPort && p.toPort <= incoming.toPort));
  filtered.push(incoming);
  filtered.sort((a, b) => a.fromPort - b.fromPort || a.toPort - b.toPort);
  return filtered;
};

// --- openPort ---

const openPortInputSchema = z
  .object({
    port: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional()
      .describe('Single port to open (shorthand for fromPort = toPort = port).'),
    fromPort: z.number().int().min(1).max(65535).optional().describe('Start of port range.'),
    toPort: z.number().int().min(1).max(65535).optional().describe('End of port range.'),
    cidr: z
      .string()
      .regex(IPV4_CIDR_REGEX, 'Must be a valid IPv4 CIDR (e.g. "203.0.113.1/32")')
      .optional()
      .describe(
        'CIDR block to allow access from (e.g. "203.0.113.1/32"). Optional: if omitted, the source IP of the most recent user message from the webapp will be used automatically.'
      ),
  })
  .refine((data) => data.fromPort == null || data.toPort == null || data.fromPort <= data.toPort, {
    message: 'fromPort must be less than or equal to toPort',
    path: ['fromPort'],
  });

const openPortName = 'openPort';

export const openPortTool: ToolDefinition<z.infer<typeof openPortInputSchema>> = {
  name: openPortName,
  handler: async (input, context) => {
    try {
      return await withPortLock(async () => {
        const sgId = getSecurityGroupId();
        const { workerId } = context;

        let fromPort: number;
        let toPort: number;

        if (input.port != null) {
          fromPort = input.port;
          toPort = input.port;
        } else if (input.fromPort != null && input.toPort != null) {
          fromPort = input.fromPort;
          toPort = input.toPort;
        } else {
          return 'Error: Either "port" or both "fromPort" and "toPort" must be specified.';
        }

        let cidr = input.cidr;
        let cidrSource = 'user-provided';

        if (!cidr) {
          const autoIp = await getSenderIp(workerId);
          if (!autoIp) {
            return 'Error: cidr was not provided and no source IP could be detected from recent user messages. Please provide a cidr explicitly (e.g. "203.0.113.1/32"). The user can find their IP at https://checkip.amazonaws.com';
          }
          if (!IPV4_ADDRESS_REGEX.test(autoIp)) {
            return `Error: detected source IP "${autoIp}" is not a valid IPv4 address. Please provide a cidr explicitly.`;
          }
          cidr = `${autoIp}/32`;
          cidrSource = 'auto-detected from user request IP';
        }

        const prefixLength = parseInt(cidr.split('/')[1]!, 10);
        if (prefixLength < MIN_CIDR_PREFIX_LENGTH) {
          return `Error: CIDR prefix length must be /${MIN_CIDR_PREFIX_LENGTH} or more restrictive (e.g. /32) to prevent overly broad access.`;
        }

        const description = `${SG_RULE_DESCRIPTION_PREFIX}:${workerId}`;

        try {
          await ec2.send(
            new AuthorizeSecurityGroupIngressCommand({
              GroupId: sgId,
              IpPermissions: [
                {
                  IpProtocol: 'tcp',
                  FromPort: fromPort,
                  ToPort: toPort,
                  IpRanges: [{ CidrIp: cidr, Description: description }],
                },
              ],
            })
          );
        } catch (e: any) {
          if (e.Code === 'InvalidPermission.Duplicate' || e.name === 'InvalidPermission.Duplicate') {
            // Rule already exists, that's fine
          } else {
            return `Error adding security group rule: ${e.name}: ${e.message}`;
          }
        }

        // Metadata update is best-effort: at this point the SG ingress rule is
        // already live so the port is reachable. A persistence failure would
        // only mean the webapp can't auto-linkify localhost:PORT references,
        // not that the port is broken. Don't fail the whole tool call for that.
        let metadataWarning = '';
        let hostname: string | undefined;
        try {
          const existing = await readOpenedPortsMetadata(workerId);
          hostname = existing.hostname ?? (await getPublicHostname());
          const merged = mergeRange(existing.openedPorts, {
            fromPort,
            toPort,
            cidr,
            openedAt: Date.now(),
          });
          const metadata: OpenedPortsMetadata = { hostname, openedPorts: merged };
          await writeOpenedPortsMetadata(workerId, metadata);
          await notifyPortsUpdate(workerId, metadata);
        } catch (e: any) {
          console.error(`openPort metadata persistence failed for ${workerId}:`, e);
          metadataWarning =
            '\n⚠ Warning: the SG ingress rule was added successfully, but persisting the port mapping for the webapp failed. Links in messages will not be auto-rewritten to the public URL. If this persists, run closePort to revoke the rule cleanly.';
        }

        const portDisplay = fromPort === toPort ? `${fromPort}` : `${fromPort}-${toPort}`;
        const url =
          hostname && fromPort === toPort
            ? `http://${hostname}:${fromPort}`
            : hostname
              ? `http://${hostname}:<PORT>`
              : '(hostname unavailable)';

        return (
          [
            `Opened port ${portDisplay} successfully.`,
            `- Security Group: ${sgId}`,
            `- Port(s): ${portDisplay}`,
            `- Allowed CIDR: ${cidr} (${cidrSource})`,
            `- Public URL: ${url}`,
            fromPort !== toPort ? `  (Replace <PORT> with actual port in range ${fromPort}-${toPort})` : '',
            ``,
            `localhost:${fromPort} / 127.0.0.1:${fromPort} references in subsequent messages will be displayed as clickable preview links in the webapp.`,
            `Use closePort to revoke all port rules when done.`,
          ]
            .filter(Boolean)
            .join('\n') + metadataWarning
        );
      });
    } catch (e: any) {
      return `Error in openPort: ${e.name}: ${e.message}`;
    }
  },
  schema: openPortInputSchema,
  toolSpec: async () => ({
    name: openPortName,
    description: `Open a public network endpoint by adding an inbound security group rule to allow access to a specific port or port range on this EC2 instance.

Either \`port\` (single port) or both \`fromPort\` and \`toPort\` (port range) must be specified.

If \`cidr\` is omitted, the tool will automatically use the source IP of the most recent user message from the webapp (as /32). This works only when the user interacted via the webapp UI. If auto-detection fails (e.g. the user interacted via Slack or no source IP was recorded), the tool returns an error and you should ask the user to provide their IP (they can check at https://checkip.amazonaws.com) and retry with an explicit cidr.

CIDR prefix must be /${MIN_CIDR_PREFIX_LENGTH} or more restrictive to prevent overly broad access.

Returns a public URL using the EC2 public DNS hostname. After opening, any \`localhost:PORT\` or \`127.0.0.1:PORT\` references in chat messages will be auto-rewritten to the public URL in the webapp.`,
    inputSchema: {
      json: zodToJsonSchemaBody(openPortInputSchema),
    },
  }),
};

// --- closePort ---

const closePortInputSchema = z.object({});

const closePortName = 'closePort';

/**
 * Revoke every security-group ingress rule that was added by openPort for the
 * given worker session and clear the persisted openedPorts metadata.
 *
 * Exported so worker lifecycle hooks (signal handler, idle kill timer) can
 * reuse the same cleanup logic.
 */
export const revokePortRules = async (workerId: string): Promise<string> =>
  withPortLock(async () => {
    const sgId = getSecurityGroupId();
    const description = `${SG_RULE_DESCRIPTION_PREFIX}:${workerId}`;

    const describeResult = await ec2.send(
      new DescribeSecurityGroupsCommand({
        GroupIds: [sgId],
      })
    );

    const sg = describeResult.SecurityGroups?.[0];
    if (!sg) {
      return 'Security group not found.';
    }

    const matchingPermissions: IpPermission[] = (sg.IpPermissions ?? [])
      .map((perm): IpPermission | null => {
        const matchingRanges = (perm.IpRanges ?? []).filter((r) => r.Description === description);
        if (matchingRanges.length === 0) return null;
        return {
          IpProtocol: perm.IpProtocol,
          FromPort: perm.FromPort,
          ToPort: perm.ToPort,
          IpRanges: matchingRanges,
        };
      })
      .filter((p): p is IpPermission => p != null);

    // Helper to best-effort clear persisted metadata / notify. Wrapped so a
    // failure here is logged but never bubbles out of the tool — the caller
    // only cares whether the SG rules were revoked.
    const clearMetadataBestEffort = async () => {
      try {
        const existing = await readOpenedPortsMetadata(workerId);
        if (existing.openedPorts.length === 0 && existing.hostname == null) return;
        const cleared: OpenedPortsMetadata = { hostname: existing.hostname, openedPorts: [] };
        await writeOpenedPortsMetadata(workerId, cleared);
        await notifyPortsUpdate(workerId, cleared);
      } catch (e) {
        console.error(`closePort metadata cleanup failed for ${workerId}:`, e);
      }
    };

    if (matchingPermissions.length === 0) {
      await clearMetadataBestEffort();
      return 'No port rules found to revoke.';
    }

    await ec2.send(
      new RevokeSecurityGroupIngressCommand({
        GroupId: sgId,
        IpPermissions: matchingPermissions,
      })
    );

    await clearMetadataBestEffort();

    return `Revoked ${matchingPermissions.length} port rule(s) from security group ${sgId}.`;
  });

export const closePortTool: ToolDefinition<z.infer<typeof closePortInputSchema>> = {
  name: closePortName,
  handler: async (_input, context) => {
    try {
      return await revokePortRules(context.workerId);
    } catch (e: any) {
      return `Error revoking port rules: ${e.name}: ${e.message}`;
    }
  },
  schema: closePortInputSchema,
  toolSpec: async () => ({
    name: closePortName,
    description:
      'Close all publicly exposed ports by revoking every inbound security group rule that was added by openPort for this session. After this, localhost:PORT links in existing messages will remain visible but will not be rewritten to public URLs.',
    inputSchema: {
      json: zodToJsonSchemaBody(closePortInputSchema),
    },
  }),
};
