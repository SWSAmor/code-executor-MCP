/**
 * Unit tests for mapWithConcurrency — the bounded startup fan-out helper.
 *
 * This replaces the unbounded `Promise.all(servers.map(connect))` in the MCP
 * client pool: connecting every downstream server at once made cold-starting
 * children contend and pushed the slowest past its connect timeout. The helper
 * must (a) process every item, (b) preserve input order in the result, and
 * (c) never run more than `limit` workers at once.
 */

import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from '../src/mcp/client-pool.js';

/** Resolve after `ms` via a microtask chain (no real timers → fast, deterministic). */
function tick(rounds: number): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < rounds; i++) {
    p = p.then(() => undefined);
  }
  return p;
}

describe('mapWithConcurrency', () => {
  it('preserves input order in the result regardless of completion order', async () => {
    const items = [0, 1, 2, 3, 4, 5];

    // Later items resolve sooner (more items complete first) — result must
    // still be in input order, not completion order.
    const result = await mapWithConcurrency(items, 3, async (n) => {
      await tick(items.length - n);
      return n * 10;
    });

    expect(result).toEqual([0, 10, 20, 30, 40, 50]);
  });

  it('processes every item exactly once', async () => {
    const items = Array.from({ length: 25 }, (_, i) => i);
    const seen: number[] = [];

    const result = await mapWithConcurrency(items, 4, async (n) => {
      seen.push(n);
      return n;
    });

    expect(result).toEqual(items);
    expect([...seen].sort((a, b) => a - b)).toEqual(items);
    expect(seen.length).toBe(items.length);
  });

  it('never exceeds the concurrency limit', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;

    await mapWithConcurrency(items, 5, async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick(3);
      inFlight--;
    });

    expect(maxInFlight).toBeLessThanOrEqual(5);
    // Sanity: with 20 items and limit 5, the window should actually fill.
    expect(maxInFlight).toBe(5);
  });

  it('passes the correct index to the worker', async () => {
    const items = ['a', 'b', 'c'];

    const result = await mapWithConcurrency(items, 2, async (item, index) => `${index}:${item}`);

    expect(result).toEqual(['0:a', '1:b', '2:c']);
  });

  it('returns an empty array for empty input (no workers spawned)', async () => {
    let called = false;
    const result = await mapWithConcurrency([], 4, async () => {
      called = true;
      return 1;
    });

    expect(result).toEqual([]);
    expect(called).toBe(false);
  });

  it('handles limit larger than item count', async () => {
    const items = [1, 2, 3];
    const result = await mapWithConcurrency(items, 100, async (n) => n * 2);

    expect(result).toEqual([2, 4, 6]);
  });

  it('treats limit < 1 as a single serial worker', async () => {
    const items = [1, 2, 3, 4];
    let inFlight = 0;
    let maxInFlight = 0;

    const result = await mapWithConcurrency(items, 0, async (n) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await tick(2);
      inFlight--;
      return n;
    });

    expect(result).toEqual(items);
    expect(maxInFlight).toBe(1);
  });
});
