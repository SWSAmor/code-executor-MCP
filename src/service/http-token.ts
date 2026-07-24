/**
 * Bearer-token bootstrap for the single-instance HTTP MCP endpoint.
 *
 * The resident service requires a bearer token (auth is on by default — a
 * code-execution endpoint on a loopback TCP port is reachable by any local
 * process and, via DNS-rebinding, by browsers). This persists a random token
 * under `~/.code-executor/http-token` with `0600` permissions so `service
 * install` can bake its value into the launchd plist and, later (PR4), inject
 * the SAME value into each host config. Idempotent: an existing non-empty token
 * file is reused rather than rotated.
 */

import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as os from 'node:os';

const TOKEN_FILENAME = 'http-token';

/** The `~/.code-executor` state directory (shared with wrappers, audit logs). */
export function getCodeExecutorDir(): string {
  return path.join(os.homedir(), '.code-executor');
}

/** Absolute path of the persisted bearer-token file. */
export function getHttpTokenPath(): string {
  return path.join(getCodeExecutorDir(), TOKEN_FILENAME);
}

/** Generate a fresh 256-bit token as a 64-character hex string (XML/URL safe). */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Return the persisted HTTP bearer token, generating and storing one (`0600`)
 * if the file is absent or empty.
 *
 * @param dir - Storage directory override (tests). Defaults to `~/.code-executor`.
 */
export async function ensureHttpToken(dir: string = getCodeExecutorDir()): Promise<string> {
  const tokenPath = path.join(dir, TOKEN_FILENAME);

  try {
    const existing = (await fs.readFile(tokenPath, 'utf-8')).trim();
    if (existing.length > 0) {
      return existing;
    }
  } catch {
    // Not present (or unreadable) — generate a new one below.
  }

  const token = generateToken();
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tokenPath, token, { mode: 0o600 });
  // Enforce 0600 even if the file pre-existed (empty) with looser permissions;
  // writeFile's mode is not applied to an already-existing file.
  await fs.chmod(tokenPath, 0o600).catch(() => {
    // Best effort — a filesystem that cannot chmod is not a reason to fail.
  });
  return token;
}
