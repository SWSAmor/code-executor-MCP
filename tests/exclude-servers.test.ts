/**
 * Tests for excludeServers config option
 *
 * Validates that servers can be excluded from loading via:
 * 1. Config-driven: `excludeServers` field in MCP config JSON
 * 2. Environment variable: `EXCLUDE_MCP_SERVERS` (comma-separated)
 * 3. Union semantics: multiple config files accumulate exclusions
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock modules BEFORE imports
vi.mock('fs/promises');
vi.mock('../src/config/loader.js');

import * as fs from 'fs/promises';
import { MCPClientPool } from '../src/mcp/client-pool.js';
import * as loader from '../src/config/loader.js';

describe('excludeServers', () => {
  let pool: MCPClientPool;
  let connectSpy: ReturnType<typeof vi.fn>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    vi.resetAllMocks();
    originalEnv = { ...process.env };
    delete process.env.EXCLUDE_MCP_SERVERS;

    // Mock getPoolConfig so the constructor doesn't fail
    vi.mocked(loader.getPoolConfig).mockReturnValue({
      maxConcurrent: 100,
      queueSize: 200,
      queueTimeoutMs: 30000,
    });

    pool = new MCPClientPool();

    // Prevent real connections and tool caching
    connectSpy = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(pool as any, 'connectToServer').mockImplementation(connectSpy);
    vi.spyOn(pool as any, 'cacheToolListings').mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.clearAllMocks();
  });

  describe('config-driven exclusion', () => {
    it('should_excludeServer_when_listedInExcludeServers', async () => {
      const config = JSON.stringify({
        mcpServers: {
          xcode: { command: 'xcode-mcp', args: [] },
          zen: { command: 'zen-mcp', args: [] },
        },
        excludeServers: ['xcode'],
      });

      vi.mocked(loader.getAllMCPConfigPaths).mockResolvedValue(['/config.json']);
      vi.mocked(fs.readFile).mockResolvedValue(config as any);

      await pool.initialize();

      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(connectSpy).toHaveBeenCalledWith('zen', expect.any(Object));
      expect(connectSpy).not.toHaveBeenCalledWith('xcode', expect.any(Object));
    });

    it('should_excludeMultipleServers_when_multipleListedInExcludeServers', async () => {
      const config = JSON.stringify({
        mcpServers: {
          xcode: { command: 'xcode-mcp', args: [] },
          slow: { command: 'slow-mcp', args: [] },
          zen: { command: 'zen-mcp', args: [] },
        },
        excludeServers: ['xcode', 'slow'],
      });

      vi.mocked(loader.getAllMCPConfigPaths).mockResolvedValue(['/config.json']);
      vi.mocked(fs.readFile).mockResolvedValue(config as any);

      await pool.initialize();

      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(connectSpy).toHaveBeenCalledWith('zen', expect.any(Object));
    });

    it('should_connectAllServers_when_excludeServersMissing', async () => {
      const config = JSON.stringify({
        mcpServers: {
          zen: { command: 'zen-mcp', args: [] },
          github: { command: 'github-mcp', args: [] },
        },
      });

      vi.mocked(loader.getAllMCPConfigPaths).mockResolvedValue(['/config.json']);
      vi.mocked(fs.readFile).mockResolvedValue(config as any);

      await pool.initialize();

      expect(connectSpy).toHaveBeenCalledTimes(2);
    });

    it('should_connectAllServers_when_excludeServersEmpty', async () => {
      const config = JSON.stringify({
        mcpServers: {
          zen: { command: 'zen-mcp', args: [] },
        },
        excludeServers: [],
      });

      vi.mocked(loader.getAllMCPConfigPaths).mockResolvedValue(['/config.json']);
      vi.mocked(fs.readFile).mockResolvedValue(config as any);

      await pool.initialize();

      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(connectSpy).toHaveBeenCalledWith('zen', expect.any(Object));
    });
  });

  describe('environment variable exclusion', () => {
    it('should_excludeServer_when_setInEnvVar', async () => {
      process.env.EXCLUDE_MCP_SERVERS = 'xcode';

      const config = JSON.stringify({
        mcpServers: {
          xcode: { command: 'xcode-mcp', args: [] },
          zen: { command: 'zen-mcp', args: [] },
        },
      });

      vi.mocked(loader.getAllMCPConfigPaths).mockResolvedValue(['/config.json']);
      vi.mocked(fs.readFile).mockResolvedValue(config as any);

      await pool.initialize();

      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(connectSpy).toHaveBeenCalledWith('zen', expect.any(Object));
    });

    it('should_excludeMultiple_when_commaSeparatedEnvVar', async () => {
      process.env.EXCLUDE_MCP_SERVERS = 'xcode, slow';

      const config = JSON.stringify({
        mcpServers: {
          xcode: { command: 'xcode-mcp', args: [] },
          slow: { command: 'slow-mcp', args: [] },
          zen: { command: 'zen-mcp', args: [] },
        },
      });

      vi.mocked(loader.getAllMCPConfigPaths).mockResolvedValue(['/config.json']);
      vi.mocked(fs.readFile).mockResolvedValue(config as any);

      await pool.initialize();

      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(connectSpy).toHaveBeenCalledWith('zen', expect.any(Object));
    });

    it('should_handleWhitespaceAndTrailingComma_when_envVarHasEdgeCases', async () => {
      process.env.EXCLUDE_MCP_SERVERS = ' xcode , , slow , ';

      const config = JSON.stringify({
        mcpServers: {
          xcode: { command: 'xcode-mcp', args: [] },
          slow: { command: 'slow-mcp', args: [] },
          zen: { command: 'zen-mcp', args: [] },
        },
      });

      vi.mocked(loader.getAllMCPConfigPaths).mockResolvedValue(['/config.json']);
      vi.mocked(fs.readFile).mockResolvedValue(config as any);

      await pool.initialize();

      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(connectSpy).toHaveBeenCalledWith('zen', expect.any(Object));
    });
  });

  describe('config + env var union', () => {
    it('should_excludeBoth_when_configAndEnvVarSetDifferentServers', async () => {
      process.env.EXCLUDE_MCP_SERVERS = 'slow';

      const config = JSON.stringify({
        mcpServers: {
          xcode: { command: 'xcode-mcp', args: [] },
          slow: { command: 'slow-mcp', args: [] },
          zen: { command: 'zen-mcp', args: [] },
        },
        excludeServers: ['xcode'],
      });

      vi.mocked(loader.getAllMCPConfigPaths).mockResolvedValue(['/config.json']);
      vi.mocked(fs.readFile).mockResolvedValue(config as any);

      await pool.initialize();

      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(connectSpy).toHaveBeenCalledWith('zen', expect.any(Object));
    });
  });

  describe('multi-config merge (union semantics)', () => {
    it('should_unionExclusions_when_multipleConfigsEachExcludeDifferentServers', async () => {
      const globalConfig = JSON.stringify({
        mcpServers: {
          xcode: { command: 'xcode-mcp', args: [] },
          slow: { command: 'slow-mcp', args: [] },
          zen: { command: 'zen-mcp', args: [] },
        },
        excludeServers: ['xcode'],
      });

      const projectConfig = JSON.stringify({
        mcpServers: {},
        excludeServers: ['slow'],
      });

      vi.mocked(loader.getAllMCPConfigPaths).mockResolvedValue([
        '/global.json',
        '/project.json',
      ]);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(globalConfig as any)
        .mockResolvedValueOnce(projectConfig as any);

      await pool.initialize();

      // Both xcode and slow excluded (union), only zen remains
      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(connectSpy).toHaveBeenCalledWith('zen', expect.any(Object));
    });

    it('should_deduplicateExclusions_when_multipleConfigsExcludeSameServer', async () => {
      const config1 = JSON.stringify({
        mcpServers: { zen: { command: 'zen-mcp', args: [] } },
        excludeServers: ['xcode'],
      });
      const config2 = JSON.stringify({
        mcpServers: { xcode: { command: 'xcode-mcp', args: [] } },
        excludeServers: ['xcode'],
      });

      vi.mocked(loader.getAllMCPConfigPaths).mockResolvedValue(['/a.json', '/b.json']);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(config1 as any)
        .mockResolvedValueOnce(config2 as any);

      await pool.initialize();

      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(connectSpy).toHaveBeenCalledWith('zen', expect.any(Object));
    });
  });

  describe('self-exclusion preserved', () => {
    it('should_alwaysExcludeCodeExecutor_when_notInExcludeServers', async () => {
      const config = JSON.stringify({
        mcpServers: {
          'code-executor': { command: 'ce', args: [] },
          zen: { command: 'zen-mcp', args: [] },
        },
      });

      vi.mocked(loader.getAllMCPConfigPaths).mockResolvedValue(['/config.json']);
      vi.mocked(fs.readFile).mockResolvedValue(config as any);

      await pool.initialize();

      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(connectSpy).toHaveBeenCalledWith('zen', expect.any(Object));
    });

    it('should_handleGracefully_when_codeExecutorExplicitlyInExcludeServers', async () => {
      const config = JSON.stringify({
        mcpServers: {
          'code-executor': { command: 'ce', args: [] },
          zen: { command: 'zen-mcp', args: [] },
        },
        excludeServers: ['code-executor'],
      });

      vi.mocked(loader.getAllMCPConfigPaths).mockResolvedValue(['/config.json']);
      vi.mocked(fs.readFile).mockResolvedValue(config as any);

      await pool.initialize();

      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(connectSpy).toHaveBeenCalledWith('zen', expect.any(Object));
    });
  });

  describe('edge cases', () => {
    it('should_notError_when_excludingNonExistentServer', async () => {
      const config = JSON.stringify({
        mcpServers: {
          zen: { command: 'zen-mcp', args: [] },
        },
        excludeServers: ['nonexistent'],
      });

      vi.mocked(loader.getAllMCPConfigPaths).mockResolvedValue(['/config.json']);
      vi.mocked(fs.readFile).mockResolvedValue(config as any);

      await pool.initialize();

      expect(connectSpy).toHaveBeenCalledTimes(1);
      expect(connectSpy).toHaveBeenCalledWith('zen', expect.any(Object));
    });

    it('should_handleStandaloneMode_when_allServersExcluded', async () => {
      const config = JSON.stringify({
        mcpServers: {
          xcode: { command: 'xcode-mcp', args: [] },
        },
        excludeServers: ['xcode'],
      });

      vi.mocked(loader.getAllMCPConfigPaths).mockResolvedValue(['/config.json']);
      vi.mocked(fs.readFile).mockResolvedValue(config as any);

      // Should not throw — standalone mode is valid
      await expect(pool.initialize()).resolves.not.toThrow();
      expect(connectSpy).not.toHaveBeenCalled();
    });
  });
});
