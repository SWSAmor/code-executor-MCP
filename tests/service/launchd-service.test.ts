/**
 * LaunchdService (resident HTTP service) tests.
 *
 * Uses a temp LaunchAgents dir + a stubbed launchctl runner + an injected
 * platform, so nothing touches the real `~/Library/LaunchAgents` or the real
 * launchd, and the suite runs on any platform.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  LaunchdService,
  DEFAULT_SERVICE_LABEL,
  escapeXml,
} from '../../src/service/launchd-service';
import type { ResidentServiceSpec } from '../../src/service/launchd-service';

const UID = 501;

function makeSpec(overrides: Partial<ResidentServiceSpec> = {}): ResidentServiceSpec {
  return {
    programPath: '/opt/code-executor/bin/code-executor-mcp',
    env: {
      CODE_EXECUTOR_ROLE: 'http',
      CODE_EXECUTOR_HTTP_PORT: '39273',
      CODE_EXECUTOR_HTTP_TOKEN: 'abc123',
    },
    stdoutPath: '/Users/x/Library/Logs/code-executor-mcp.log',
    stderrPath: '/Users/x/Library/Logs/code-executor-mcp.error.log',
    ...overrides,
  };
}

describe('escapeXml', () => {
  it('escapes the five XML metacharacters', () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe(
      'a &amp; b &lt; c &gt; d &quot; e &apos; f'
    );
  });
});

describe('LaunchdService', () => {
  let launchAgentsDir: string;
  let runLaunchctl: ReturnType<typeof vi.fn>;
  let service: LaunchdService;

  beforeEach(() => {
    launchAgentsDir = mkdtempSync(join(tmpdir(), 'ce-launchd-'));
    runLaunchctl = vi.fn().mockResolvedValue(undefined);
    service = new LaunchdService({
      launchAgentsDir,
      uid: UID,
      platform: 'darwin',
      runLaunchctl,
    });
  });

  afterEach(() => {
    rmSync(launchAgentsDir, { recursive: true, force: true });
  });

  describe('constructor validation', () => {
    it('defaults to the reverse-DNS service label', () => {
      expect(service.serviceLabel).toBe(DEFAULT_SERVICE_LABEL);
      expect(service.plistFilePath).toBe(join(launchAgentsDir, `${DEFAULT_SERVICE_LABEL}.plist`));
    });

    it('rejects a label with path-traversal characters', () => {
      expect(() => new LaunchdService({ label: '../../evil', launchAgentsDir })).toThrow(
        /only alphanumerics/
      );
    });

    it('rejects a label with shell/special characters', () => {
      expect(() => new LaunchdService({ label: 'foo;bar', launchAgentsDir })).toThrow(
        /only alphanumerics/
      );
    });
  });

  describe('generatePlist()', () => {
    it('declares a resident daemon (RunAtLoad + KeepAlive) running the binary', () => {
      const plist = service.generatePlist(makeSpec());
      expect(plist).toContain('<key>RunAtLoad</key>');
      expect(plist).toContain('<key>KeepAlive</key>');
      expect(plist).toContain(`<string>${DEFAULT_SERVICE_LABEL}</string>`);
      expect(plist).toContain('<key>ProgramArguments</key>');
      expect(plist).toContain('<string>/opt/code-executor/bin/code-executor-mcp</string>');
      // No StartCalendarInterval — this is a daemon, not the sync timer.
      expect(plist).not.toContain('StartCalendarInterval');
    });

    it('renders each env var as a key/string pair', () => {
      const plist = service.generatePlist(makeSpec());
      expect(plist).toContain('<key>CODE_EXECUTOR_ROLE</key>');
      expect(plist).toContain('<string>http</string>');
      expect(plist).toContain('<key>CODE_EXECUTOR_HTTP_TOKEN</key>');
      expect(plist).toContain('<string>abc123</string>');
    });

    it('sets the log paths', () => {
      const plist = service.generatePlist(makeSpec());
      expect(plist).toContain('<key>StandardOutPath</key>');
      expect(plist).toContain('<string>/Users/x/Library/Logs/code-executor-mcp.log</string>');
      expect(plist).toContain('<key>StandardErrorPath</key>');
    });

    it('XML-escapes interpolated env values', () => {
      const plist = service.generatePlist(
        makeSpec({ env: { MCP_CONFIG_PATH: '/tmp/a & b/<config>.json' } })
      );
      expect(plist).toContain('<string>/tmp/a &amp; b/&lt;config&gt;.json</string>');
      expect(plist).not.toContain('a & b/<config>');
    });
  });

  describe('install()', () => {
    it('writes the plist 0600 and (re)loads via launchctl', async () => {
      await service.install(makeSpec());

      const written = await fs.readFile(service.plistFilePath, 'utf-8');
      expect(written).toContain('<key>KeepAlive</key>');

      const mode = (await fs.stat(service.plistFilePath)).mode & 0o777;
      expect(mode).toBe(0o600);

      // bootout first (clean reload), then bootstrap the domain with the plist.
      expect(runLaunchctl).toHaveBeenCalledWith(['bootout', `gui/${UID}/${DEFAULT_SERVICE_LABEL}`]);
      expect(runLaunchctl).toHaveBeenCalledWith([
        'bootstrap',
        `gui/${UID}`,
        service.plistFilePath,
      ]);
    });

    it('still bootstraps when the pre-load bootout fails (not currently loaded)', async () => {
      runLaunchctl.mockImplementation(async (args: string[]) => {
        if (args[0] === 'bootout') throw new Error('not loaded');
      });
      await expect(service.install(makeSpec())).resolves.not.toThrow();
      expect(runLaunchctl).toHaveBeenCalledWith([
        'bootstrap',
        `gui/${UID}`,
        service.plistFilePath,
      ]);
    });

    it('rejects a non-absolute programPath', async () => {
      await expect(service.install(makeSpec({ programPath: 'bin/code-executor-mcp' }))).rejects.toThrow(
        /must be absolute/
      );
    });
  });

  describe('uninstall()', () => {
    it('boots out and removes the plist', async () => {
      await service.install(makeSpec());
      await expect(fs.access(service.plistFilePath)).resolves.toBeUndefined();

      await service.uninstall();
      expect(runLaunchctl).toHaveBeenCalledWith(['bootout', `gui/${UID}/${DEFAULT_SERVICE_LABEL}`]);
      await expect(fs.access(service.plistFilePath)).rejects.toThrow();
    });

    it('does not throw when nothing is installed', async () => {
      runLaunchctl.mockRejectedValue(new Error('not loaded'));
      await expect(service.uninstall()).resolves.not.toThrow();
    });
  });

  describe('restart()', () => {
    it('kickstarts the service', async () => {
      await service.restart();
      expect(runLaunchctl).toHaveBeenCalledWith([
        'kickstart',
        '-k',
        `gui/${UID}/${DEFAULT_SERVICE_LABEL}`,
      ]);
    });
  });

  describe('isLoaded() / plistExists()', () => {
    it('isLoaded reflects the launchctl print exit', async () => {
      runLaunchctl.mockResolvedValue(undefined);
      expect(await service.isLoaded()).toBe(true);
      runLaunchctl.mockRejectedValue(new Error('no such service'));
      expect(await service.isLoaded()).toBe(false);
    });

    it('plistExists reflects the file on disk', async () => {
      expect(await service.plistExists()).toBe(false);
      await service.install(makeSpec());
      expect(await service.plistExists()).toBe(true);
    });
  });

  describe('platform guard', () => {
    it('refuses to install off macOS', async () => {
      const linux = new LaunchdService({ launchAgentsDir, uid: UID, platform: 'linux', runLaunchctl });
      await expect(linux.install(makeSpec())).rejects.toThrow(/macOS-only/);
      expect(runLaunchctl).not.toHaveBeenCalled();
    });
  });
});
