/**
 * Graceful child-process termination.
 *
 * WHY: when the client pool shuts down it must stop the downstream MCP servers
 * it spawned (e.g. basic-memory). A flat "sleep N then check once" wastes time
 * for a child that exits immediately on SIGTERM and gives no headroom for one
 * that needs a moment. This polls for exit instead: SIGTERM → check existence
 * every `pollIntervalMs` → return as soon as the child is gone → SIGKILL only if
 * it is still alive once the bounded grace window elapses.
 *
 * Pure and dependency-injected (`kill`, `sleep`, `logger`) so it is unit-testable
 * with fake timers and a mock kill, without spawning real processes.
 */

import { isErrnoException } from '../utils/utils.js';

/**
 * Outcome of a graceful kill:
 *  - `'gone'`   — the process was already dead when we tried to SIGTERM it.
 *  - `'exited'` — it exited on its own within the grace window after SIGTERM.
 *  - `'killed'` — it was still alive at the deadline and got SIGKILLed.
 */
export type KillResult = 'gone' | 'exited' | 'killed';

/**
 * Options for {@link killProcessGracefully}.
 */
export interface KillProcessOptions {
  /** Signal sender. Default: `process.kill` bound to `process`. */
  kill?: (pid: number, signal: NodeJS.Signals | number) => void;
  /** Existence-probe cadence in milliseconds. Default: 250. */
  pollIntervalMs?: number;
  /** Total grace window in milliseconds before SIGKILL. Default: 30_000. */
  timeoutMs?: number;
  /** Sleep helper. Default: `setTimeout`-based. Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Optional diagnostic logger (goes to stderr in production). */
  logger?: (message: string) => void;
  /** Human-readable server name for log lines. */
  serverName?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * Probe whether `pid` is still alive using signal 0 (no signal is delivered).
 */
function isAlive(pid: number, kill: (pid: number, signal: NodeJS.Signals | number) => void): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false; // ESRCH (gone) or EPERM — treat as "cannot confirm alive"
  }
}

/**
 * SIGTERM a process, poll for its exit, and SIGKILL it if it outlives the grace
 * window. Never throws — termination is best-effort by design.
 */
export async function killProcessGracefully(
  pid: number,
  opts: KillProcessOptions = {}
): Promise<KillResult> {
  const kill = opts.kill ?? ((p: number, signal: NodeJS.Signals | number) => process.kill(p, signal));
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = opts.logger ?? (() => {});
  const label = opts.serverName ? `${opts.serverName} (PID ${pid})` : `PID ${pid}`;

  // Step 1: ask the child to exit.
  try {
    kill(pid, 'SIGTERM');
    log(`✓ Sent SIGTERM to ${label}`);
  } catch (error) {
    if (isErrnoException(error) && error.code === 'ESRCH') {
      return 'gone'; // already dead — nothing to do
    }
    // e.g. EPERM: we cannot signal it and SIGKILL would fail too. Best effort.
    log(`Error sending SIGTERM to ${label}: ${String(error)}`);
    return 'gone';
  }

  // Step 2: poll for exit across the grace window.
  const iterations = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  for (let i = 0; i < iterations; i++) {
    await sleep(pollIntervalMs);
    if (!isAlive(pid, kill)) {
      log(`✓ ${label} exited gracefully`);
      return 'exited';
    }
  }

  // Step 3: still alive at the deadline — force kill.
  try {
    kill(pid, 'SIGKILL');
    log(`⚠️  Force killed ${label} with SIGKILL`);
  } catch {
    // Raced to exit between the last probe and now — fine.
  }
  return 'killed';
}
