/**
 * Tests for the code-executor spawn-cycle guards.
 *
 * A code-executor wired (directly, or indirectly via another MCP host) as a
 * downstream server of another code-executor forms a spawn cycle that
 * fork-bombs the machine. These tests cover the two code-level defences:
 *
 *  1. Path-based self-exclusion — a downstream server whose command IS
 *     code-executor itself is skipped at pool init, regardless of its config
 *     key name (the name-based exclusion only catches the "code-executor" key).
 *
 *  2. Parent-PID ancestry guard — if any ancestor process is itself a
 *     code-executor, the pool runs in LEAF MODE (connects to nothing),
 *     breaking indirect cycles even when the intermediate host strips the
 *     environment. Overridable via CODE_EXECUTOR_ALLOW_NESTED.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock modules BEFORE imports
vi.mock('fs/promises');
vi.mock('../src/config/loader.js');

import * as fs from 'fs/promises';
import { MCPClientPool } from '../src/mcp/client-pool.js';
import * as loader from '../src/config/loader.js';

describe('recursion guard', () => {
  let pool: MCPClientPool;
  let connectSpy: ReturnType<typeof vi.fn>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.resetAllMocks();
    originalEnv = { ...process.env };
    delete process.env.CODE_EXECUTOR_ALLOW_NESTED;

    vi.mocked(loader.getPoolConfig).mockReturnValue({
      maxConcurrent: 100,
      queueSize: 200,
      queueTimeoutMs: 30000,
      connectTimeoutMs: 15000,
    });

    pool = new MCPClientPool();

    // Prevent real connections and tool caching
    connectSpy = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(pool as any, 'connectToServer').mockImplementation(connectSpy);
    vi.spyOn(pool as any, 'cacheToolListings').mockResolvedValue(undefined);

    // Default: not nested (deterministic — avoids a real `ps` walk).
    vi.spyOn(MCPClientPool as any, 'hasCodeExecutorAncestor').mockReturnValue(false);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  describe('path-based self-exclusion', () => {
    it('should_skipDownstream_when_commandIsCodeExecutorBinary_underAnyName', async () => {
      const config = JSON.stringify({
        mcpServers: {
          // Wired self in under a NON-"code-executor" key — name check misses it.
          'my-nested-ce': { command: '/opt/tools/bin/code-executor-mcp', args: [] },
          zen: { command: 'zen-mcp', args: [] },
        },
      });
      vi.mocked(loader.getAllMCPConfigPaths).mockResolvedValue(['/config.json']);
      vi.mocked(fs.readFile).mockResolvedValue(config as any);

      await pool.initialize();

      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(connectSpy).toHaveBeenCalledWith('zen', expect.any(Object));
      expect(connectSpy).not.toHaveBeenCalledWith('my-nested-ce', expect.any(Object));
    });

    it('should_skipDownstream_when_commandEqualsOwnExecutablePath', async () => {
      const config = JSON.stringify({
        mcpServers: {
          self: { command: process.execPath, args: [] },
          zen: { command: 'zen-mcp', args: [] },
        },
      });
      vi.mocked(loader.getAllMCPConfigPaths).mockResolvedValue(['/config.json']);
      vi.mocked(fs.readFile).mockResolvedValue(config as any);

      await pool.initialize();

      expect(connectSpy).not.toHaveBeenCalledWith('self', expect.any(Object));
      expect(connectSpy).toHaveBeenCalledWith('zen', expect.any(Object));
    });

    it('should_notSkipDownstream_when_commandIsUnrelatedBinary', async () => {
      const config = JSON.stringify({
        mcpServers: {
          // basename "code-executor-client" must NOT match "code-executor-mcp"
          decoy: { command: '/usr/bin/code-executor-client', args: [] },
        },
      });
      vi.mocked(loader.getAllMCPConfigPaths).mockResolvedValue(['/config.json']);
      vi.mocked(fs.readFile).mockResolvedValue(config as any);

      await pool.initialize();

      expect(connectSpy).toHaveBeenCalledWith('decoy', expect.any(Object));
    });
  });

  describe('parent-PID ancestry guard (leaf mode)', () => {
    it('should_connectToNothing_when_codeExecutorAncestorPresent', async () => {
      vi.spyOn(MCPClientPool as any, 'hasCodeExecutorAncestor').mockReturnValue(true);

      const config = JSON.stringify({
        mcpServers: {
          zen: { command: 'zen-mcp', args: [] },
          other: { command: 'other-mcp', args: [] },
        },
      });
      vi.mocked(loader.getAllMCPConfigPaths).mockResolvedValue(['/config.json']);
      vi.mocked(fs.readFile).mockResolvedValue(config as any);

      await pool.initialize();

      // Leaf mode: returns before connecting to anything.
      expect(connectSpy).not.toHaveBeenCalled();
      expect(pool.listAllTools()).toEqual([]);
    });

    it('should_connectNormally_when_noCodeExecutorAncestor', async () => {
      // hasCodeExecutorAncestor already mocked to false in beforeEach.
      const config = JSON.stringify({
        mcpServers: {
          zen: { command: 'zen-mcp', args: [] },
        },
      });
      vi.mocked(loader.getAllMCPConfigPaths).mockResolvedValue(['/config.json']);
      vi.mocked(fs.readFile).mockResolvedValue(config as any);

      await pool.initialize();

      expect(connectSpy).toHaveBeenCalledWith('zen', expect.any(Object));
    });

    it('should_ignoreAncestorGuard_when_allowNestedEnvSet', async () => {
      process.env.CODE_EXECUTOR_ALLOW_NESTED = '1';
      vi.spyOn(MCPClientPool as any, 'hasCodeExecutorAncestor').mockReturnValue(true);

      const config = JSON.stringify({
        mcpServers: {
          zen: { command: 'zen-mcp', args: [] },
        },
      });
      vi.mocked(loader.getAllMCPConfigPaths).mockResolvedValue(['/config.json']);
      vi.mocked(fs.readFile).mockResolvedValue(config as any);

      await pool.initialize();

      // Override in effect: connects despite the ancestor.
      expect(connectSpy).toHaveBeenCalledWith('zen', expect.any(Object));
    });
  });
});
