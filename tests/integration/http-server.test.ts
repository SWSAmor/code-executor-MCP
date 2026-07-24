/**
 * Integration test for the single-shared-instance HTTP MCP server, run against
 * the REAL compiled binary (the deployed artifact), started with
 * CODE_EXECUTOR_ROLE=http. Verifies readiness, bearer-token auth, and that an
 * initialize handshake opens a session — the security-critical surface of the
 * HTTP transport.
 *
 * Requires a freshly built binary: `npm run build:binary`.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(import.meta.url), '..');
const BIN = resolve(here, '../../bin/code-executor-mcp');

// A fixed, uncommon loopback port for the test server (kept off the 39273 default
// so a real running instance is never disturbed).
const PORT = 41573;
const TOKEN = 'test-token-abc123';
const BASE = `http://127.0.0.1:${PORT}`;
const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
};
const INITIALIZE_BODY = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'http-integration-test', version: '1.0.0' },
  },
});

let child: ChildProcess | undefined;
let tmpDir: string;

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

describe.skipIf(!existsSync(BIN))('HTTP MCP server (real binary)', () => {
  beforeAll(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'ce-http-'));
    const configPath = join(tmpDir, 'mcp.json');
    writeFileSync(configPath, JSON.stringify({ mcpServers: {} }), 'utf-8'); // no downstream → fast start

    child = spawn(BIN, [], {
      env: {
        ...process.env,
        CODE_EXECUTOR_ROLE: 'http',
        CODE_EXECUTOR_HTTP_PORT: String(PORT),
        CODE_EXECUTOR_HTTP_TOKEN: TOKEN,
        MCP_CONFIG_PATH: configPath,
        ENABLE_HEALTH_CHECK: 'false', // avoid the separate :3000 K8s health server
      },
      stdio: ['ignore', 'ignore', 'inherit'],
    });

    const ready = await waitFor(async () => {
      try {
        const res = await fetch(`${BASE}/health`);
        return res.ok;
      } catch {
        return false;
      }
    }, 20_000);
    expect(ready, 'HTTP server did not become ready').toBe(true);
  }, 30_000);

  afterAll(() => {
    if (child?.pid) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('serves an unauthenticated readiness probe at /health', async () => {
    const res = await fetch(`${BASE}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.healthy).toBe(true);
  });

  it('rejects an /mcp request with no bearer token (401)', async () => {
    const res = await fetch(`${BASE}/mcp`, { method: 'POST', headers: MCP_HEADERS, body: INITIALIZE_BODY });
    expect(res.status).toBe(401);
  });

  it('rejects an /mcp request with a wrong bearer token (401)', async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, Authorization: 'Bearer wrong-token' },
      body: INITIALIZE_BODY,
    });
    expect(res.status).toBe(401);
  });

  it('opens a session on an authenticated initialize (200 + Mcp-Session-Id)', async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN}` },
      body: INITIALIZE_BODY,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-session-id')).toBeTruthy();
    // Drain the response so the connection closes cleanly.
    await res.text();
  });

  it('rejects a non-initialize POST with no session id (400)', async () => {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { ...MCP_HEADERS, Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(400);
  });
});
