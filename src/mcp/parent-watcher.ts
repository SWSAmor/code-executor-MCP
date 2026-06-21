/**
 * Active parent-liveness watcher for the stdio MCP transport.
 *
 * WHY: stdin EOF (see stdin-watcher.ts) is the primary signal that the MCP host
 * (our parent) is gone, but it is not always delivered — the host can be
 * SIGKILLed, or a launcher/wrapper (or a child that inherited fd 0) can hold the
 * write end of our stdin pipe open, so the EOF never arrives. When that happens
 * the server — and every downstream MCP child it spawned (e.g. basic-memory,
 * which then keeps holding its SQLite lock) — orphans forever.
 *
 * On POSIX a process whose parent dies is reparented to init/launchd (PID 1), so
 * `process.ppid` changing away from its startup value is a reliable, polling-based
 * "parent is gone" signal that does not depend on the pipe. This complements the
 * stdin watcher rather than replacing it.
 *
 * Kept as a standalone, side-effect-free module (mirrors stdin-watcher.ts) so it
 * is unit-testable with an injected `getPpid` and fake timers — importing the
 * main server module would run its startup side effects.
 */

/**
 * Options for {@link watchParentExit}.
 */
export interface WatchParentExitOptions {
  /** Reads the current parent PID. Default: `() => process.ppid`. */
  getPpid: () => number;
  /** Parent PID captured at startup, used as the reference for "reparented". */
  initialPpid: number;
  /** Poll cadence in milliseconds. */
  intervalMs: number;
  /** Whether the platform has POSIX reparent-to-PID-1 semantics. */
  isPosix: boolean;
  /** Invoked exactly once when the parent is detected gone. */
  onParentExit: (reason: string) => void;
}

/**
 * Poll parent liveness and invoke `onParentExit` exactly once when the parent
 * is gone (the process has been reparented away from its startup parent).
 *
 * No-op (returns a no-op stop) when:
 *  - `isPosix` is false (Windows reparent semantics differ — stdin EOF is relied
 *    on there), or
 *  - `initialPpid <= 1` (the process was launched directly by init/launchd, so
 *    "ppid === 1" is not a death signal — avoids a false positive).
 *
 * @returns A `stop()` function that halts polling.
 */
export function watchParentExit(opts: WatchParentExitOptions): () => void {
  const { getPpid, initialPpid, intervalMs, isPosix, onParentExit } = opts;

  // Guard clauses: situations where the poll cannot give a reliable signal.
  if (!isPosix || initialPpid <= 1) {
    return () => {};
  }

  let fired = false;
  const timer = setInterval(() => {
    if (fired) {
      return;
    }
    // Reparented away from the startup parent (→ PID 1 on POSIX) ⇒ parent gone.
    if (getPpid() !== initialPpid) {
      fired = true;
      clearInterval(timer);
      onParentExit('reparented');
    }
  }, intervalMs);

  // Don't keep the event loop alive solely for this poll.
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  return () => clearInterval(timer);
}
