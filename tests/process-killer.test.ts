/**
 * Tests for graceful child-process termination.
 *
 * On shutdown the client pool must stop the downstream MCP servers it spawned
 * (e.g. basic-memory). The current code does a flat 2s sleep then a single
 * existence check; killProcessGracefully() replaces that with SIGTERM →
 * poll-for-exit → SIGKILL-on-timeout, so a well-behaved child that exits quickly
 * is not delayed, while a wedged child is force-killed once the bounded grace
 * window elapses.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { killProcessGracefully } from '../src/mcp/process-killer.js';

function esrch(): NodeJS.ErrnoException {
  const err = new Error('kill ESRCH') as NodeJS.ErrnoException;
  err.code = 'ESRCH';
  return err;
}

describe('killProcessGracefully', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should_sendSIGTERMFirst_when_invoked', async () => {
    // Child never dies → we will eventually SIGKILL, but SIGTERM must come first.
    const kill = vi.fn(); // all signals succeed (child stays alive)

    const p = killProcessGracefully(123, { kill, timeoutMs: 1000, pollIntervalMs: 250 });
    await vi.advanceTimersByTimeAsync(1000);
    await p;

    expect(kill.mock.calls[0]).toEqual([123, 'SIGTERM']);
  });

  it('should_notSendSIGKILL_when_childExitsBeforeTimeout', async () => {
    let aliveProbes = 0;
    const kill = vi.fn((_pid: number, signal: NodeJS.Signals | number) => {
      if (signal === 0) {
        aliveProbes++;
        if (aliveProbes >= 2) throw esrch(); // gone on the 2nd existence probe
        return; // still alive on the 1st probe
      }
      // SIGTERM succeeds
    });

    const p = killProcessGracefully(123, { kill, timeoutMs: 30_000, pollIntervalMs: 250 });
    await vi.advanceTimersByTimeAsync(500); // two poll intervals
    const result = await p;

    expect(result).toBe('exited');
    expect(kill).not.toHaveBeenCalledWith(123, 'SIGKILL');
  });

  it('should_sendSIGKILL_when_childStillAlivePastTimeout', async () => {
    const kill = vi.fn(); // existence probe never throws → child always "alive"

    const p = killProcessGracefully(123, { kill, timeoutMs: 1000, pollIntervalMs: 250 });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await p;

    expect(result).toBe('killed');
    expect(kill).toHaveBeenCalledWith(123, 'SIGKILL');
  });

  it('should_returnGone_when_initialSIGTERMThrowsESRCH', async () => {
    const kill = vi.fn((_pid: number, _signal: NodeJS.Signals | number) => {
      throw esrch(); // process already dead
    });

    const p = killProcessGracefully(123, { kill, timeoutMs: 1000, pollIntervalMs: 250 });
    const result = await p;

    expect(result).toBe('gone');
    expect(kill).toHaveBeenCalledTimes(1); // only the SIGTERM attempt
    expect(kill).not.toHaveBeenCalledWith(123, 'SIGKILL');
  });
});
