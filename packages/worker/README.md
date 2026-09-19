# Worker

This is the agent implementation that works in its own EC2 environment.

## Run locally

You can run the agent locally using the below command. Note that you must provide `BUCKET_NAME` and `TABLE_NAME` using the actual ARN.

```sh
cd packages/common
npm run watch
```

```sh
cd packages/worker
npm run setup:local
npm run start:local

# access http://localhost:8001 for DynamoDB Admin
```

## kiro-cli ACP resilience env vars

The ACP-SDK loop (`kiroAcpSdkAgentLoop`, the live path via `kiro-backend.ts`)
treats "kiro-cli is a thing that breaks" as the default assumption. Its
behaviour is tunable via the environment variables below. All are optional —
the defaults are production-safe, and every feature toggle defaults to ON with
an off-switch for fast rollback. A duration of `0` disables the corresponding
timeout/probe.

| Env var                            | Default         | Meaning                                                                                                                                                                                         |
| ---------------------------------- | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KIRO_ACP_RETRY_MAX_PER_CLASS`     | `3`             | Retry ladder: max in-turn retries per failure class (process-died / wedged / busy / idle-timeout / …). Each class has an independent budget within a turn.                                                |
| `KIRO_ACP_RETRY_MAX_TOTAL`         | `6`             | Turn-level cap on the TOTAL in-turn retries across all classes, so a flapping turn cannot spin the subprocess indefinitely.                                                              |
| `KIRO_ACP_RETRY_EMPTY_RESPONSE`    | `off`           | Retry ladder: when on, an empty (no text, no tools) successful response is retried once per budget. Default off — an intentional silent turn is normal here.                                              |
| `KIRO_ACP_IDLE_TIMEOUT_MS`         | `600000` (10m)  | Watchdog: idle timeout (no chunk / tool activity, no tool in-flight) that fires the cancel probe. `0` disables the idle watchdog.                                                            |
| `KIRO_ACP_WALL_CLOCK_HARD_MS`      | `1800000` (30m) | Watchdog: hard wall-clock ceiling per prompt — the always-lethal runaway guard (never deferred by an in-flight tool). `0` disables the hard ceiling.                                            |
| `KIRO_ACP_CANCEL_PROBE`            | `on`            | Cancel probe: enable the non-lethal `session/cancel` probe on idle. Off → an idle watchdog fire immediately surfaces as a (lethal) idle-timeout.                                                          |
| `KIRO_ACP_CANCEL_ACK_TIMEOUT_MS`   | `5000`          | Cancel probe: bounded wait for the probe's cancel ack / any liveness signal before declaring a confirmed wedge.                                                                                           |
| `KIRO_ACP_PROC_LIVENESS`           | `on`            | Proc-liveness: enable `/proc`-based subprocess-tree liveness measurement (Linux/AgentCore). Off → rely on timers + the cancel probe only.                                                                                |
| `KIRO_ACP_TOOL_PROBE_INTERVAL_MS`  | `60000`         | Proc-liveness: interval of the tool-in-flight liveness probe that makes an early DEAD verdict reachable (a tool child that vanished with no result frame). `0` disables it.                           |
| `KIRO_ACP_PROCESS_REUSE`           | `on`            | Process reuse: keep one live kiro-cli subprocess + ACP session across turns (avoids the per-turn spawn→synth→load→dispose churn, the leading -32603 cause). Off → per-turn fresh spawn (pre-reuse behaviour). |
| `KIRO_ACP_PROCESS_MAX_AGE_MS`      | `21600000` (6h) | Process reuse: max age a pooled process may live before it is recycled. Idle recycling is already bounded by the 30-min worker kill-timer.                                                                 |
| `KIRO_ACP_INITIALIZE_TIMEOUT_MS`   | `120000`        | c5: outer ceiling for the connect + initialize handshake (sized strictly above the inner session bounds so it never mislabels an inner phase). `0` disables.                                    |
| `KIRO_ACP_SESSION_NEW_TIMEOUT_MS`  | `30000`         | c5: bound for `session/new`.                                                                                                                                                                    |
| `KIRO_ACP_SESSION_LOAD_TIMEOUT_MS` | `120000`        | c5: bound for `session/load` (raised from the legacy implicit 30s because a resume re-registers every MCP server, which can be slow).                                                           |
| `KIRO_ACP_DISPOSE_GRACE_MS`        | `5000`          | Bounded grace for each await in `dispose()` (graceful teardown, then post-SIGKILL exit reaping) so a wedged subprocess cannot hang finalize. `0` disables the bound.                    |
