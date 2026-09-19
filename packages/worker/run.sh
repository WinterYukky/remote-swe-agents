#!/bin/bash
# runner script for AgentCore Runtime
# dependencies:
#   - aws cli
#   - node

set -euo pipefail

# AgentCore V2 caps the runtime env-var payload at 1024 bytes, so the CDK stack
# stores most of the worker configuration in a single SSM parameter (JSON) and
# passes only its name via RUNTIME_ENV_PARAMETER_NAME. Load it here and export
# each key so every downstream `process.env.X` consumer keeps working unchanged.
# Existing env vars take precedence (we only set a key when it is currently
# unset/empty), so a real env override still wins.
if [ -n "${RUNTIME_ENV_PARAMETER_NAME:-}" ]; then
    RUNTIME_ENV_JSON=$(aws ssm get-parameter \
        --name "$RUNTIME_ENV_PARAMETER_NAME" \
        --query "Parameter.Value" \
        --output text)
    # Node parses the JSON and emits one `KEY<TAB>VALUE` line per entry. We read
    # them with a NUL-safe-ish TSV loop and `export` each, sidestepping all
    # bash-quoting pitfalls with ARNs/paths in the values. Values are validated
    # to be single-line (they always are for our config) so a plain read works.
    RUNTIME_ENV_TSV=$(printf '%s' "$RUNTIME_ENV_JSON" | node -e '
        let raw = "";
        process.stdin.on("data", (c) => (raw += c));
        process.stdin.on("end", () => {
          const obj = JSON.parse(raw);
          for (const [k, v] of Object.entries(obj)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
            const val = String(v).replace(/[\r\n\t]/g, " ");
            process.stdout.write(k + "\t" + val + "\n");
          }
        });
    ')
    while IFS=$'\t' read -r _k _v; do
        [ -z "$_k" ] && continue
        # Existing non-empty env vars win over the overflow parameter.
        if [ -z "${!_k:-}" ]; then
            export "$_k=$_v"
        fi
    done <<< "$RUNTIME_ENV_TSV"
fi

if [ -n "${GITHUB_APP_PRIVATE_KEY_PARAMETER_NAME:-}" ]; then
    aws ssm get-parameter \
        --name $GITHUB_APP_PRIVATE_KEY_PARAMETER_NAME \
        --query "Parameter.Value" \
        --output text > /opt/private-key.pem
    export GITHUB_APP_PRIVATE_KEY_PATH="/opt/private-key.pem"
fi

if [ -n "${GITHUB_PERSONAL_ACCESS_TOKEN_PARAMETER_NAME:-}" ]; then
    export GITHUB_PERSONAL_ACCESS_TOKEN=$(aws ssm get-parameter --name $GITHUB_PERSONAL_ACCESS_TOKEN_PARAMETER_NAME --query "Parameter.Value" --output text)
fi

if [ -n "${SLACK_BOT_TOKEN_PARAMETER_NAME:-}" ]; then
  export SLACK_BOT_TOKEN=$(aws ssm get-parameter --name $SLACK_BOT_TOKEN_PARAMETER_NAME --query "Parameter.Value" --output text)
fi

exec node --import tsx src/agent-core.ts
