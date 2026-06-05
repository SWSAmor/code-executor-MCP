/**
 * stdout hygiene for the stdio MCP transport.
 *
 * WHY: An MCP server speaking JSON-RPC over stdio MUST emit nothing but framed
 * JSON-RPC messages on stdout — the MCP SDK writes those via
 * `process.stdout.write` directly. Any stray `console.log()` (which also writes
 * to stdout) is interleaved into that byte stream and corrupts it. A strict
 * host then rejects the line; e.g. Claude Desktop surfaces:
 *
 *     Unexpected token '✓', "✓ HTTP ser"... is not valid JSON
 *
 * (the `✓ HTTP server drained successfully` log emitted by the per-execution
 * proxy server is one such offender — there are ~18 `console.log` call sites
 * across the server path).
 *
 * Diagnostics must therefore go to stderr. Rather than convert every call site
 * and re-police it forever, this routes `console.log`/`info`/`debug` to stderr
 * at process start. `console.error`/`console.warn` already target stderr and
 * are left untouched, as is the SDK's own `process.stdout.write` of JSON-RPC
 * frames (it does not go through `console`).
 *
 * Call this ONLY in stdio-server mode. CLI subcommands (setup wizard,
 * sync-wrappers) intentionally print to stdout for the user.
 */
export function redirectConsoleLogToStderr(consoleObj: Console = console): void {
  // Bind to the (current) stderr-backed methods so the rerouted calls preserve
  // the original formatting/inspection behaviour of console.error.
  const toStderr = (...args: unknown[]): void => {
    consoleObj.error(...args);
  };

  consoleObj.log = toStderr;
  consoleObj.info = toStderr;
  consoleObj.debug = toStderr;
}
