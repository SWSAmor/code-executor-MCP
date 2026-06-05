/**
 * Client-disconnect detection for the stdio MCP transport.
 *
 * WHY: When the MCP host (our parent process, e.g. Claude Code) exits, our
 * stdin pipe receives EOF. On macOS a child process is NOT signalled when its
 * parent dies (there is no `PR_SET_PDEATHSIG` equivalent), and the MCP SDK's
 * StdioServerTransport listens only for 'data'/'error' on stdin — it never
 * translates EOF into a transport close. So this stdin EOF is the only reliable
 * signal that the client is gone. Without acting on it, the server (and every
 * downstream MCP child it spawned) lingers forever as an orphan after the host
 * exits.
 *
 * Kept as a standalone, side-effect-free module so it is unit-testable with a
 * fake stream — importing the main server module would run its startup side
 * effects (signal handlers, server.start()).
 */

import type { EventEmitter } from 'node:events';

/**
 * Invoke `onDisconnect` exactly once when `stdin` reaches EOF or closes.
 *
 * Both 'end' (no more data to read) and 'close' (stream fully closed) can fire
 * for a single disconnect; the internal guard ensures `onDisconnect` runs at
 * most once.
 *
 * @param stdin - The input stream to watch (typically `process.stdin`).
 * @param onDisconnect - Called with the triggering event name ('end'/'close').
 */
export function watchClientDisconnect(
  stdin: EventEmitter,
  onDisconnect: (reason: string) => void
): void {
  let fired = false;

  const fire = (reason: string): void => {
    if (fired) {
      return;
    }
    fired = true;
    onDisconnect(reason);
  };

  stdin.once('end', () => fire('end'));
  stdin.once('close', () => fire('close'));
}
