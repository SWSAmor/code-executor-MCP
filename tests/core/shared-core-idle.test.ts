/**
 * SharedCore lazy/idle downstream-pool tests.
 *
 * Injects fake MCPClientPool + ConnectionPool collaborators (so no real
 * downstream servers are spawned) and drives the idle timer with fake timers.
 * The health-check server is disabled via ENABLE_HEALTH_CHECK=false so
 * startBackgroundServices does not bind a real port.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SharedCore } from '../../src/core/shared-core';
import type { MCPClientPool } from '../../src/mcp/client-pool';
import type { ConnectionPool } from '../../src/mcp/connection-pool';

function makeFakePool() {
  return {
    initialize: vi.fn().mockResolvedValue(undefined),
    disconnect: vi.fn().mockResolvedValue(undefined),
    listAllTools: vi.fn().mockReturnValue([]),
  };
}

function makeFakeConnectionPool(active = 0) {
  return {
    getStats: vi.fn().mockReturnValue({ active, waiting: 0, max: 100 }),
    drain: vi.fn().mockResolvedValue(undefined),
  };
}

function buildCore(fakePool: ReturnType<typeof makeFakePool>, active = 0): SharedCore {
  return new SharedCore({
    mcpClientPool: fakePool as unknown as MCPClientPool,
    connectionPool: makeFakeConnectionPool(active) as unknown as ConnectionPool,
  });
}

describe('SharedCore lazy/idle pool', () => {
  let prevHealth: string | undefined;

  beforeEach(() => {
    prevHealth = process.env.ENABLE_HEALTH_CHECK;
    process.env.ENABLE_HEALTH_CHECK = 'false';
  });

  afterEach(() => {
    if (prevHealth === undefined) delete process.env.ENABLE_HEALTH_CHECK;
    else process.env.ENABLE_HEALTH_CHECK = prevHealth;
    vi.useRealTimers();
  });

  it('eager mode (idleMs 0) builds the pool at startup', async () => {
    const pool = makeFakePool();
    const core = buildCore(pool);

    await core.startBackgroundServices(); // no poolIdleMs → eager
    expect(pool.initialize).toHaveBeenCalledTimes(1);
  });

  it('lazy mode defers the build until the first tool call', async () => {
    const pool = makeFakePool();
    const core = buildCore(pool);

    await core.startBackgroundServices({ poolIdleMs: 5000 });
    expect(pool.initialize).not.toHaveBeenCalled();

    await core.ensurePoolReady();
    expect(pool.initialize).toHaveBeenCalledTimes(1);
  });

  it('ensurePoolReady is idempotent across concurrent callers', async () => {
    const pool = makeFakePool();
    const core = buildCore(pool);
    await core.startBackgroundServices({ poolIdleMs: 5000 });

    await Promise.all([core.ensurePoolReady(), core.ensurePoolReady(), core.ensurePoolReady()]);
    expect(pool.initialize).toHaveBeenCalledTimes(1);
  });

  it('tears down after idle with no sessions, then rebuilds on demand', async () => {
    vi.useFakeTimers();
    const pool = makeFakePool();
    const core = buildCore(pool);

    await core.startBackgroundServices({ poolIdleMs: 5000 });
    core.onSessionOpen();
    await core.ensurePoolReady();
    expect(pool.initialize).toHaveBeenCalledTimes(1);

    // Last session closes → idle timer armed; fire it.
    core.onSessionClose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(pool.disconnect).toHaveBeenCalledTimes(1);

    // Next tool call rebuilds the pool.
    await core.ensurePoolReady();
    expect(pool.initialize).toHaveBeenCalledTimes(2);
  });

  it('does not tear down while a session is still open', async () => {
    vi.useFakeTimers();
    const pool = makeFakePool();
    const core = buildCore(pool);

    await core.startBackgroundServices({ poolIdleMs: 5000 });
    core.onSessionOpen();
    await core.ensurePoolReady();

    // A second host connects and stays; no teardown should ever fire.
    core.onSessionOpen();
    core.onSessionClose(); // back to 1 active session
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pool.disconnect).not.toHaveBeenCalled();
  });

  it('a reconnect during the idle window cancels the pending teardown', async () => {
    vi.useFakeTimers();
    const pool = makeFakePool();
    const core = buildCore(pool);

    await core.startBackgroundServices({ poolIdleMs: 5000 });
    core.onSessionOpen();
    await core.ensurePoolReady();
    core.onSessionClose(); // arm timer

    await vi.advanceTimersByTimeAsync(2500); // partway through the window
    core.onSessionOpen(); // reconnect cancels the timer
    await vi.advanceTimersByTimeAsync(5000);
    expect(pool.disconnect).not.toHaveBeenCalled();
  });

  it('defers teardown while an execution is in flight, then reclaims once idle', async () => {
    vi.useFakeTimers();
    const pool = makeFakePool();
    // active execution present at first
    const core = new SharedCore({
      mcpClientPool: pool as unknown as MCPClientPool,
      connectionPool: { getStats: vi.fn().mockReturnValue({ active: 1, waiting: 0, max: 100 }) } as unknown as ConnectionPool,
    });

    await core.startBackgroundServices({ poolIdleMs: 5000 });
    core.onSessionOpen();
    await core.ensurePoolReady();
    core.onSessionClose();

    // Idle timer fires but an execution is active → teardown deferred (re-armed).
    await vi.advanceTimersByTimeAsync(5000);
    expect(pool.disconnect).not.toHaveBeenCalled();

    // Execution finishes; the re-armed timer now reclaims the pool.
    (core as unknown as { connectionPool: ConnectionPool }).connectionPool.getStats = vi
      .fn()
      .mockReturnValue({ active: 0, waiting: 0, max: 100 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(pool.disconnect).toHaveBeenCalledTimes(1);
  });

  it('a full shutdown cancels any pending idle teardown', async () => {
    vi.useFakeTimers();
    const pool = makeFakePool();
    const core = buildCore(pool);

    await core.startBackgroundServices({ poolIdleMs: 5000 });
    core.onSessionOpen();
    await core.ensurePoolReady();
    core.onSessionClose(); // arm idle timer

    await core.shutdown(); // should cancel the timer (and disconnect once, itself)
    const disconnectsAfterShutdown = pool.disconnect.mock.calls.length;

    await vi.advanceTimersByTimeAsync(10_000);
    // No ADDITIONAL disconnect from a stray idle timer after shutdown.
    expect(pool.disconnect.mock.calls.length).toBe(disconnectsAfterShutdown);
  });
});
