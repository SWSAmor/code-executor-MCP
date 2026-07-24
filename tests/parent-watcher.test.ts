/**
 * Tests for the active parent-liveness watcher.
 *
 * stdin EOF (see stdin-watcher.ts) is the primary host-disconnect signal, but it
 * can fail to fire — the host is SIGKILLed, or a wrapper / an inherited fd holds
 * the write end of our stdin pipe open. Without a second signal the server (and
 * the downstream MCP children it spawned, e.g. basic-memory) orphans forever.
 *
 * watchParentExit() polls process.ppid: on POSIX, when the parent dies the child
 * is reparented to init/launchd (PID 1), so ppid changing away from its startup
 * value is a reliable "parent is gone" signal. This converts that into a single
 * shutdown trigger.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { watchParentExit } from '../src/mcp/parent-watcher.js';

describe('watchParentExit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should_invokeOnParentExitOnce_when_reparentedToInit', () => {
    let ppid = 4242;
    const onParentExit = vi.fn();

    watchParentExit({
      getPpid: () => ppid,
      initialPpid: 4242,
      intervalMs: 1000,
      isPosix: true,
      onParentExit,
    });

    vi.advanceTimersByTime(1000);
    expect(onParentExit).not.toHaveBeenCalled();

    // Parent dies → reparented to PID 1
    ppid = 1;
    vi.advanceTimersByTime(1000);

    expect(onParentExit).toHaveBeenCalledTimes(1);
    expect(onParentExit).toHaveBeenCalledWith('reparented');
  });

  it('should_invokeOnParentExitAtMostOnce_when_polledRepeatedlyAfterReparent', () => {
    let ppid = 5000;
    const onParentExit = vi.fn();

    watchParentExit({
      getPpid: () => ppid,
      initialPpid: 5000,
      intervalMs: 500,
      isPosix: true,
      onParentExit,
    });

    ppid = 1;
    vi.advanceTimersByTime(500 * 5); // five more polls after reparent

    expect(onParentExit).toHaveBeenCalledTimes(1);
  });

  it('should_notInvokeOnParentExit_when_ppidStaysAtInitial', () => {
    const onParentExit = vi.fn();

    watchParentExit({
      getPpid: () => 7777,
      initialPpid: 7777,
      intervalMs: 1000,
      isPosix: true,
      onParentExit,
    });

    vi.advanceTimersByTime(1000 * 10);

    expect(onParentExit).not.toHaveBeenCalled();
  });

  it('should_beNoOp_when_notPosix', () => {
    let ppid = 1234;
    const onParentExit = vi.fn();

    watchParentExit({
      getPpid: () => ppid,
      initialPpid: 1234,
      intervalMs: 1000,
      isPosix: false, // Windows: ppid reparent semantics differ — rely on stdin EOF
      onParentExit,
    });

    ppid = 1;
    vi.advanceTimersByTime(1000 * 10);

    expect(onParentExit).not.toHaveBeenCalled();
  });

  it('should_beDisabled_when_initialPpidIsInitOrLess', () => {
    // Launched directly by init/launchd: ppid is already 1, so "ppid === 1"
    // is not a death signal. Avoid the false positive entirely.
    let ppid = 1;
    const onParentExit = vi.fn();

    watchParentExit({
      getPpid: () => ppid,
      initialPpid: 1,
      intervalMs: 1000,
      isPosix: true,
      onParentExit,
    });

    ppid = 1;
    vi.advanceTimersByTime(1000 * 10);

    expect(onParentExit).not.toHaveBeenCalled();
  });

  it('should_stopPolling_when_stopCalled', () => {
    let ppid = 9000;
    const onParentExit = vi.fn();

    const stop = watchParentExit({
      getPpid: () => ppid,
      initialPpid: 9000,
      intervalMs: 1000,
      isPosix: true,
      onParentExit,
    });

    stop();
    ppid = 1;
    vi.advanceTimersByTime(1000 * 10);

    expect(onParentExit).not.toHaveBeenCalled();
  });
});
