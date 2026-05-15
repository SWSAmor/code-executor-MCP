/**
 * Runtime detection helpers.
 *
 * Used to gate features that don't make sense in a compiled single-binary
 * distribution (e.g., self-installation via `npm install -g`).
 */

declare const Bun: { version?: string } | undefined;

/**
 * True when running as a `bun --compile` compiled binary.
 *
 * Heuristic: Bun is defined and `process.execPath` is not the `bun` runtime
 * itself — in compiled mode it points to the produced binary instead.
 *
 * Override with `CODE_EXECUTOR_FORCE_COMPILED=1` for testing.
 */
export function isCompiledBinary(): boolean {
  if (process.env.CODE_EXECUTOR_FORCE_COMPILED === '1') return true;
  if (typeof Bun === 'undefined') return false;
  const exec = process.execPath.toLowerCase();
  return !exec.endsWith('/bun') && !exec.endsWith('\\bun.exe') && !exec.endsWith('bun');
}
