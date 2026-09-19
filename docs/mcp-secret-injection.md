# MCP secret injection (custom-agent MCP servers)

Custom agents can reference secrets stored in **AWS Secrets Manager** from their
`mcpConfig` without ever writing the secret value into the agent definition,
DynamoDB, or any on-disk profile JSON. The worker resolves the placeholders at
MCP-server spawn time and drops any server whose placeholders cannot all be
resolved.

> This page has two parts:
>
> - **Usage guide** (below) — everything a custom-agent author needs.
> - **[Implementation & security notes (maintainers)](#implementation--security-notes-maintainers)**
>   — internals, storage, IAM and known limitations.

---

## Usage guide

### Placeholders

| Placeholder          | Resolves to                                                              |
| -------------------- | ------------------------------------------------------------------------ |
| `${secret:NAME}`     | The secret's string value, substituted inline.                           |
| `${secretFile:NAME}` | A path to a 0600 file (in a 0700 per-process dir) containing the secret. |

`NAME` maps to the Secrets Manager secret **`remote-swe/mcp-secrets/NAME`**. The
prefix is a namespace so IAM can scope the worker to exactly this family of
secrets.

`NAME` must match `^(?=.*[a-zA-Z0-9])[a-zA-Z0-9_.-]+$` — at least one
alphanumeric character, and only `[A-Za-z0-9_.-]`. No path separators or
expansion characters. Dot-only / separator-only names (`.`, `..`, `-`, `_`) are
rejected.

### Creating a secret

Secrets are **not** provisioned by CDK; create them manually in the worker's
account/region:

```bash
aws secretsmanager create-secret \
  --name "remote-swe/mcp-secrets/my-integration-token" \
  --secret-string "the-token-value"

# rotate / update later:
aws secretsmanager put-secret-value \
  --secret-id "remote-swe/mcp-secrets/my-integration-token" \
  --secret-string "the-new-value"
```

For a file-shaped secret referenced via `${secretFile:...}`, store the full file
contents as the secret string (e.g. the JSON of an OAuth credentials file).

### Example `mcpConfig`

```json
{
  "mcpServers": {
    "my-integration": {
      "command": "npx",
      "args": ["-y", "@vendor/mcp-server"],
      "env": {
        "API_TOKEN": "${secret:my-integration-token}",
        "GOOGLE_APPLICATION_CREDENTIALS": "${secretFile:google-oauth-json}"
      }
    }
  }
}
```

This reads Secrets Manager secrets `remote-swe/mcp-secrets/my-integration-token`
and `remote-swe/mcp-secrets/google-oauth-json`.

### Where placeholders are resolved

- **stdio** servers: in `command`, each `args` entry, and each `env` value.
- **http / sse** servers: **not** in the `url`. A placeholder in a `url` is
  treated as a dangling placeholder and the whole server is **dropped** — a
  secret value must never be embedded in a URL (it leaks via logs, referrers and
  history), and the custom-agent `url` schema has no header field to carry a
  bearer secret. Use a stdio server with `env` / `${secretFile:...}` instead.

### Put tokens/keys in `env` or `secretFile`, not `command`/`args`

- **`command` / `args` are visible in `/proc/<pid>/cmdline`** to any process in
  the container. Prefer `env` or `${secretFile:...}` for secret VALUES. An
  inline `${secret:...}` in `command`/`args` is supported, but its resolved
  value ends up on the process command line — use it only for non-sensitive
  values (e.g. a resolved binary path), not for tokens/keys.
- Prefer `${secretFile:...}` for anything a server can read from a file (OAuth
  token JSON, key files); the value never appears in the process env or command
  line.

### Fail-closed literal scanning (gotcha — verified in E2E)

Scanning is **textual over the whole value**, not just intentional
placeholders. Every `command`, every `args` entry, and every `env` value of a
stdio server is searched for the `${secret:NAME}` / `${secretFile:NAME}` pattern
regardless of context. So if you write a string that merely _looks like_ a
placeholder — for example an inline snippet passed via `args` that happens to
contain `${secret:...}`-shaped text (JS/shell template literals, a regex, an
example in a help string) — it is treated as a real placeholder:

- If `NAME` is valid and the Secrets Manager secret exists, it is silently
  substituted (probably not what you intended).
- If `NAME` is invalid (fails the name rules) or the secret does not exist, the
  resolution throws and the **entire MCP server is dropped** (fail-closed) — the
  server simply will not start, and only a `console.error` is logged.

**Workarounds for authors** who need a literal `${secret:...}`-shaped string in
`command`/`args`/`env` (not a real placeholder):

- Break up the token so it no longer matches, e.g. write `"${" + "secret:x}"` in
  the code your server receives, or inject the literal at runtime inside the MCP
  server rather than through `mcpConfig`.
- Avoid embedding arbitrary code/snippets in `args`; pass a file path (or a
  `${secretFile:...}`) and keep the snippet inside the server instead.
- Remember the pattern is only `${secret:...}` / `${secretFile:...}` — any other
  `${...}` shape (e.g. `${HOME}`) is left untouched.

---

## Implementation & security notes (maintainers)

Implementation: `packages/worker/src/agent/kiro-mcp-secrets.ts`.

### secretFile lifecycle & storage

- `${secretFile:NAME}` writes the value to
  `<os.tmpdir()>/remote-swe-mcp-secrets-<random>/NAME` with `0600` perms in a
  `0700` directory. The directory random suffix is chosen **once per worker
  process** and is stable across turns (see the reuse-key note below).
- On AgentCore the container `/tmp` is **overlayfs (disk-backed)**, not a
  tmpfs/RAM mount, so these files touch disk. The `0700`/`0600` permissions are
  the protection, not memory residency.
- The worker registers a best-effort cleanup that removes the per-process
  directory on normal `exit` and on `SIGTERM`/`SIGINT`. A hard kill (SIGKILL) or
  crash cannot run cleanup, so on-disk permissions remain the primary control.

### Reuse-key / rotation asymmetry

The resolved MCP server list is folded into the `kiro-agent-pool` reuse key. The
secretFile path is deliberately **stable within a process** so it does not
change the reuse key every turn (which would defeat turn-to-turn kiro-cli
process reuse). A consequence: a **rotated secret VALUE is not re-materialised
into a pooled subprocess until that process is recycled** — up to
`KIRO_ACP_PROCESS_MAX_AGE_MS` (default 6h).

### IAM

The worker role must be able to read secrets under the namespace prefix:

```json
{
  "Effect": "Allow",
  "Action": "secretsmanager:GetSecretValue",
  "Resource": "arn:aws:secretsmanager:<region>:<account-id>:secret:remote-swe/mcp-secrets/*"
}
```

> NOTE: depending on your deployment, the worker role may already hold broader
> permissions; the prefix-scoped statement above is the recommended minimum.

### Tenant-isolation caveat

Secrets live in a single global namespace (`remote-swe/mcp-secrets/*`) with no
per-custom-agent binding. Any custom agent can reference any secret name. This
is acceptable for a single-tenant deployment but is **not** tenant-isolated —
add a per-agent binding before using this in a multi-tenant deployment.
