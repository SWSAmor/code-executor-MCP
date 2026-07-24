/**
 * ensureHttpToken() tests — token generation, 0600 persistence, idempotence.
 * Uses a temp directory override so nothing touches the real ~/.code-executor.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureHttpToken, generateToken } from '../../src/service/http-token';

describe('generateToken', () => {
  it('produces a 64-character hex string', () => {
    const token = generateToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a distinct value each call', () => {
    expect(generateToken()).not.toBe(generateToken());
  });
});

describe('ensureHttpToken', () => {
  let dir: string;
  let tokenPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ce-token-'));
    tokenPath = join(dir, 'http-token');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('generates and persists a token with 0600 permissions', async () => {
    const token = await ensureHttpToken(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    const onDisk = (await fs.readFile(tokenPath, 'utf-8')).trim();
    expect(onDisk).toBe(token);

    const mode = (await fs.stat(tokenPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('is idempotent — reuses the existing token', async () => {
    const first = await ensureHttpToken(dir);
    const second = await ensureHttpToken(dir);
    expect(second).toBe(first);
  });

  it('regenerates when the token file is empty', async () => {
    await fs.writeFile(tokenPath, '   \n', { mode: 0o600 });
    const token = await ensureHttpToken(dir);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect((await fs.readFile(tokenPath, 'utf-8')).trim()).toBe(token);
  });
});
