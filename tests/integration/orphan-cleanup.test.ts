/**
 * End-to-end orphan-cleanup test against the REAL compiled binary.
 *
 * The project ships a bun standalone binary (bin/code-executor-mcp); unit tests
 * of the TS source do not prove its runtime behavior (see CLAUDE.md). This test
 * spawns that binary, has it connect to a real downstream STDIO MCP child (the
 * fake-mcp-server fixture), then makes the parent go away two ways:
 *   1. stdin EOF (host disconnect) — exercises the stdin-watcher path
 *   2. the binary's parent process is killed — exercises the parent-watcher poll
 * and asserts the downstream child is reaped (no orphan) and the binary exits.
 *
 * SAFETY / isolation: the binary is run with HOME pointed at a throwaway temp
 * dir and a config that registers ONLY the fake server, so it can never connect
 * to the developer's real MCP servers (basic-memory etc.). Both bun and node
 * honor $HOME for os.homedir(), which is what config discovery uses.
 *
 * Skips entirely when the binary has not been built (e.g. CI, fresh clone) —
 * mirrors tests/integration/sampling-flow.test.ts.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(import.meta.url), '..');
const BINARY = resolve(here, '../../bin/code-executor-mcp');
const FIXTURE = resolve(here, 'fixtures/fake-mcp-server.mjs');
const hasBinary = existsSync(BINARY);

const CHILD_SHUTDOWN_MS = 2000; // short grace so the test is fast
const describeBinary = hasBinary ? describe : describe.skip;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitFor(predicate: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await delay(intervalMs);
  }
  return predicate();
}

async function readPidWhenReady(pidFile: string, timeoutMs: number): Promise<number> {
  await waitFor(() => existsSync(pidFile), timeoutMs);
  const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
  if (isNaN(pid)) throw new Error(`fake server PID file not written within ${timeoutMs}ms`);
  return pid;
}

interface Workspace {
  home: string;
  fakePidFile: string;
  /** Env for the binary: isolated HOME + fast shutdown knobs. */
  env: NodeJS.ProcessEnv;
}

function setupWorkspace(): Workspace {
  const home = mkdtempSync(join(tmpdir(), 'ce-orphan-'));
  const fakePidFile = join(home, 'fake.pid');
  // detectMCPConfigLocation() (startup gate) AND the pool both read
  // $HOME/.claude.json; register only the fake downstream server there.
  const config = {
    mcpServers: {
      fake: {
        command: process.execPath, // node
        args: [FIXTURE],
        env: { FAKE_MCP_PID_FILE: fakePidFile },
      },
    },
  };
  writeFileSync(join(home, '.claude.json'), JSON.stringify(config));

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    ENABLE_HEALTH_CHECK: 'false',
    CODE_EXECUTOR_ALLOW_NESTED: '1', // never enter LEAF MODE — we need the child
    CODE_EXECUTOR_CHILD_SHUTDOWN_TIMEOUT_MS: String(CHILD_SHUTDOWN_MS),
    CODE_EXECUTOR_PARENT_POLL_INTERVAL_MS: '300',
    CODE_EXECUTOR_CLIENT_CLOSE_TIMEOUT_MS: '1000',
  };
  return { home, fakePidFile, env };
}

const spawned: ChildProcess[] = [];
const homes: string[] = [];

afterEach(() => {
  // Best-effort sweep: kill any process we spawned (and their groups) and remove temp homes.
  for (const p of spawned) {
    if (p.pid) {
      try { process.kill(-p.pid, 'SIGKILL'); } catch { /* not a leader / gone */ }
      try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ }
    }
  }
  spawned.length = 0;
  for (const h of homes) {
    try { rmSync(h, { recursive: true, force: true }); } catch { /* best effort */ }
  }
  homes.length = 0;
});

describeBinary('orphan cleanup (real binary)', () => {
  it('reaps its downstream child and exits cleanly when stdin closes (host disconnect)', async () => {
    const ws = setupWorkspace();
    homes.push(ws.home);

    const proc = spawn(BINARY, [], { cwd: ws.home, env: ws.env, stdio: ['pipe', 'pipe', 'pipe'] });
    spawned.push(proc);
    let stderr = '';
    proc.stderr?.on('data', (d) => (stderr += String(d)));
    const exited = new Promise<number | null>((res) => proc.on('exit', (code) => res(code)));

    const childPid = await readPidWhenReady(ws.fakePidFile, 25000);
    expect(isAlive(childPid)).toBe(true);
    await delay(500); // let the binary register the child in its `processes` map

    proc.stdin?.end(); // EOF → host-disconnect shutdown

    const code = await Promise.race([
      exited,
      delay(15000).then(() => 'timeout' as const),
    ]);
    const reaped = await waitFor(() => !isAlive(childPid), CHILD_SHUTDOWN_MS + 4000);

    expect(reaped, `downstream child ${childPid} was not reaped.\nbinary stderr:\n${stderr}`).toBe(true);
    expect(code).toBe(0);
  }, 45000);

  it('detects parent death (ppid poll) and reaps its downstream child', async () => {
    const ws = setupWorkspace();
    homes.push(ws.home);
    const binPidFile = join(ws.home, 'binary.pid');

    // Launch the binary under an intermediate `sh` whose stdin is fed by a
    // long-lived `sleep`. When we kill ONLY the sh (not its group), the binary
    // is reparented to PID 1 but its stdin stays OPEN (sleep holds the write
    // end) — so the stdin-watcher cannot fire and the parent-watcher poll is the
    // only thing that can trigger shutdown.
    const script = `sleep 30 | "${BINARY}" & echo $! > "${binPidFile}"; wait`;
    const launcher = spawn('sh', ['-c', script], {
      cwd: ws.home,
      env: ws.env,
      stdio: ['ignore', 'ignore', 'ignore'],
      detached: true, // own process group, so we can kill just `sh` and sweep the group later
    });
    spawned.push(launcher);

    const childPid = await readPidWhenReady(ws.fakePidFile, 25000);
    const binPid = await readPidWhenReady(binPidFile, 5000);
    expect(isAlive(childPid)).toBe(true);
    expect(isAlive(binPid)).toBe(true);
    await delay(500);

    // Kill ONLY the launcher shell (positive PID). The binary + sleep reparent
    // to init; the binary keeps running until its parent-watcher poll notices.
    try { process.kill(launcher.pid as number, 'SIGKILL'); } catch { /* gone */ }

    const binGone = await waitFor(() => !isAlive(binPid), 12000);
    const childGone = await waitFor(() => !isAlive(childPid), CHILD_SHUTDOWN_MS + 4000);

    expect(binGone, `binary ${binPid} did not shut down after its parent died`).toBe(true);
    expect(childGone, `downstream child ${childPid} was not reaped`).toBe(true);
  }, 45000);
});
