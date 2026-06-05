/**
 * Tests for stdout hygiene on the stdio MCP transport.
 *
 * On stdio, stdout carries the JSON-RPC frames written by the SDK. A stray
 * console.log() lands on the same stream and corrupts it — strict hosts then
 * reject the line (e.g. "Unexpected token '✓' ... is not valid JSON").
 * redirectConsoleLogToStderr() reroutes log/info/debug to stderr so only
 * JSON-RPC reaches stdout.
 */

import { describe, it, expect, vi } from 'vitest';
import { redirectConsoleLogToStderr } from '../src/utils/stdio-guard.js';

function makeFakeConsole() {
  return {
    log: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  } as unknown as Console;
}

describe('redirectConsoleLogToStderr', () => {
  it('should_routeLogToError_when_consoleLogCalled', () => {
    const fake = makeFakeConsole();
    const originalError = fake.error;

    redirectConsoleLogToStderr(fake);
    fake.log('✓ HTTP server drained successfully');

    expect(originalError).toHaveBeenCalledTimes(1);
    expect(originalError).toHaveBeenCalledWith('✓ HTTP server drained successfully');
  });

  it('should_routeInfoAndDebugToError_when_called', () => {
    const fake = makeFakeConsole();
    const originalError = fake.error;

    redirectConsoleLogToStderr(fake);
    fake.info('info line');
    fake.debug('debug line');

    expect(originalError).toHaveBeenCalledTimes(2);
    expect(originalError).toHaveBeenNthCalledWith(1, 'info line');
    expect(originalError).toHaveBeenNthCalledWith(2, 'debug line');
  });

  it('should_preserveErrorAndWarn_when_redirected', () => {
    const fake = makeFakeConsole();
    const originalError = fake.error;
    const originalWarn = fake.warn;

    redirectConsoleLogToStderr(fake);

    // error/warn already target stderr and must not be reassigned.
    expect(fake.error).toBe(originalError);
    expect(fake.warn).toBe(originalWarn);
  });
});
