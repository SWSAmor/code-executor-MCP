# MCP Pool Startup Resilience & Spawn-Cycle Protection

Status: implemented (branch `fix/mcp-pool-startup-resilience`)

This note documents two production failure modes observed when code-executor
runs behind an MCP host (the Hermes agent gateway), their root causes, the
fixes, and — importantly — *why* each fix is shaped the way it is. The
alternatives that were tried and rejected are recorded so the reasoning is not
lost.

## Symptoms

1. **Respawn storm** — hundreds of code-executor startups in the host log
   (`~/.hermes/logs/mcp-stderr.log`), restarting roughly once per second; many
   downstream MCP child processes left behind.
2. **Fork bomb** — dozens of `code-executor-mcp` *and* `hermes mcp serve`
   processes, growing every ~2 seconds, in a clean alternating parent chain.

## Root causes

### A. Startup coupled to downstream pool init → respawn loop

Original `start()` order:

```
await mcpClientPool.initialize();   // connect to ALL downstream servers (blocking)
await server.connect(transport);    // only now answer the host's MCP handshake
```

`initialize()` used `Promise.allSettled` over all downstream connects with **no
per-server timeout**, so a single slow/unreachable server (HTTP servers were the
worst offenders) blocked the whole thing. The host's `initialize` request went
unanswered past its startup timeout → the host killed the process and respawned
it → loop. Each spawn had already begun launching child MCP servers, which were
then orphaned.

### B. Cyclic MCP topology → fork bomb

Not direct self-inclusion — code-executor is correctly excluded from its own
pool by the `code-executor` config key. The real cause was a **cycle through a
second program**:

- the host's MCP config lists `code-executor` as a server;
- code-executor's merged config (`~/.mcp_ce.json`) lists the host
  (`hermes mcp serve`) as a downstream server.

So: `gateway → code-executor → hermes mcp serve → code-executor → hermes → …`
Name-based self-exclusion cannot catch this because the intermediary
(`hermes`) is a different program.

## Fixes

### 1. Decouple the upstream handshake from downstream pool init

`start()` now connects the stdio transport to the host **first**, then runs
`mcpClientPool.initialize()` in the **background** (`this.poolReady`). The host
gets its `initialize`/`tools/list` answer immediately, independent of downstream
health. The `executeTypescript`/`executePython` handlers `await this.poolReady`
before running, so downstream tools are ready (or known-unavailable) by the time
user code executes. A total downstream failure is caught and logged — the server
stays up instead of crashing.

### 2. Per-server connect timeout + graceful degradation

Each connect races against `POOL_CONNECT_TIMEOUT_MS` (default 15 s). A hung
server is recorded as failed; the pool comes up with whatever connected. A
failed/timed-out server is **never** added to `clients`/`toolCache`, so its tools
are neither discoverable nor callable — partial availability "just works".
`initialize()` logs a per-server report (✓/✗ + duration + reason).

### 3. Recursion guard via parent-PID ancestry (the key fix for B)

At startup, walk the parent-PID chain with `ps`; if any ancestor process is
itself a code-executor (`argv0` basename `code-executor-mcp`), run in **LEAF
MODE** — connect to no downstream servers and return. This bounds the cycle:

```
gateway → code-executor (full) → hermes mcp serve → code-executor (LEAF — stops)
```

Override with `CODE_EXECUTOR_ALLOW_NESTED=1`.

### 4. Path-based self-exclusion

A downstream server whose command IS code-executor itself (binary basename, or
exact `process.execPath`) is skipped regardless of its config key name — catches
"wired self in under a different name".

### 5. Orphan reaping

In-flight transports are tracked in `pendingStdioTransports` and reaped on
shutdown; a synchronous `process.on('exit')` handler SIGKILLs all spawned
children as a last-resort backstop (covers host SIGKILL after a timeout).

## Design decisions & rejected alternatives

- **Background pool init vs. just adding timeouts.** Timeouts alone still risk
  exceeding an unknown host startup window. Answering the handshake first fully
  decouples our readiness from downstream health — the robust fix.

- **Process ancestry vs. an inherited env marker.** The first attempt stamped
  spawned children with `CODE_EXECUTOR_DEPTH+1` and went leaf at a max depth.
  **It failed in production:** `hermes mcp serve` does **not** forward our
  environment to the code-executor it spawns, so the marker never arrived and
  the fork bomb continued. Parent PIDs are always readable from the process
  table, independent of what the intermediary does with the environment. The env
  approach was removed.

- **Why the whole chain, not just the direct parent.** In the cyclic case the
  direct parent is the host (`hermes`), not a code-executor; the code-executor
  ancestor is one hop further up.

- **Why match `argv0` basename, not the full command line.** Matching the whole
  command line produced a false positive: a top-level instance launched via a
  shell wrapper (`sh -c "… /path/code-executor-mcp …"`) counted its own launcher
  as an ancestor and wrongly went leaf. `argv0` of a shell wrapper is `sh`.

- **Why LEAF MODE, not exit.** A nested instance that exits would make the host
  see a failed MCP server and likely respawn it → back to a respawn loop.
  Staying alive but inert answers the host's handshake and is stable.

- **Why this cannot reach "exactly one" process for the cyclic config.** The
  nested code-executor is spawned by the *host*, not by code-executor, so
  code-executor cannot prevent its creation; it can only make it inert (leaf).
  The host and the nested leaf instance are a stable, harmless pair. Reaching a
  single process requires breaking the config cycle (remove the host entry from
  code-executor's downstream config, or remove code-executor from the host's
  config) — the cycle is fundamentally a configuration issue; the guards make it
  *safe*, not invisible.

## Runtime notes (Bun)

The shipped artifact is a `bun --compile` single binary, so `process.execPath`
is the code-executor binary itself, signal/`process.kill` and `process.on('exit')`
behave as on Node, and child kill is done explicitly by PID because the
AbortController-based kill in the MCP SDK's stdio transport is not reliable under
Bun. The ancestry walk uses `ps`; on platforms without it (Windows) the guard is
best-effort and simply does not engage.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `POOL_CONNECT_TIMEOUT_MS` | `15000` | Per-downstream-server connect timeout (1000–120000). |
| `CODE_EXECUTOR_ALLOW_NESTED` | unset | Set to `1`/`true` to disable the ancestry leaf-mode guard. |

## Verification

Unit tests: `tests/recursion-guard.test.ts` (self-exclusion + leaf mode +
override), `tests/pool-config-validation.test.ts` (`connectTimeoutMs`).

Manual, on the compiled binary: confirmed the transport connects before pool
init; a hung server is timed out and its child killed; a top-level instance runs
full while an instance it transitively spawns (with the environment stripped, as
the host does) detects the ancestor and runs leaf, spawning nothing.
