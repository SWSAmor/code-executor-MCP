/**
 * Tests for the stdio client-disconnect watcher.
 *
 * When the MCP host (parent process) exits, our stdin pipe receives EOF. On
 * macOS no death signal reaches the child and the SDK transport never acts on
 * the EOF, so without watching stdin the server — and every downstream MCP
 * child it spawned — orphans forever. watchClientDisconnect() converts that
 * EOF/close into a single shutdown trigger.
 */

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { watchClientDisconnect } from '../src/mcp/stdin-watcher.js';

describe('watchClientDisconnect', () => {
  it('should_invokeOnDisconnect_when_stdinEmitsEnd', () => {
    const stdin = new EventEmitter();
    const onDisconnect = vi.fn();

    watchClientDisconnect(stdin, onDisconnect);
    stdin.emit('end');

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledWith('end');
  });

  it('should_invokeOnDisconnect_when_stdinEmitsClose', () => {
    const stdin = new EventEmitter();
    const onDisconnect = vi.fn();

    watchClientDisconnect(stdin, onDisconnect);
    stdin.emit('close');

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledWith('close');
  });

  it('should_invokeOnDisconnectOnce_when_bothEndAndCloseFire', () => {
    // A real stdin pipe emits 'end' then 'close' for a single disconnect;
    // shutdown must be triggered only once.
    const stdin = new EventEmitter();
    const onDisconnect = vi.fn();

    watchClientDisconnect(stdin, onDisconnect);
    stdin.emit('end');
    stdin.emit('close');

    expect(onDisconnect).toHaveBeenCalledTimes(1);
    expect(onDisconnect).toHaveBeenCalledWith('end');
  });

  it('should_notInvokeOnDisconnect_when_streamStillOpen', () => {
    // 'data' (normal traffic) must never be mistaken for a disconnect.
    const stdin = new EventEmitter();
    const onDisconnect = vi.fn();

    watchClientDisconnect(stdin, onDisconnect);
    stdin.emit('data', Buffer.from('{"jsonrpc":"2.0"}'));

    expect(onDisconnect).not.toHaveBeenCalled();
  });
});
