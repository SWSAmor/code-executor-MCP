/**
 * Resident launchd service manager (macOS).
 *
 * WHY: in HTTP mode a single code-executor process must already be running
 * before any host connects — an HTTP MCP client cannot spawn its own server the
 * way a stdio host does. launchd is the macOS way to keep such a user service
 * resident: `RunAtLoad` starts it at login and `KeepAlive` restarts it on crash.
 *
 * This is DISTINCT from {@link ../cli/schedulers/launchd-scheduler} (a
 * `StartCalendarInterval` timer for the daily wrapper sync): here the plist
 * declares a long-running background daemon, not a scheduled one-shot.
 *
 * Security:
 * - The plist is written `0600` — it carries the bearer token in
 *   `EnvironmentVariables`.
 * - Every interpolated value is XML-escaped (paths, env keys/values).
 * - The label is validated to a safe charset so it can never traverse out of
 *   `~/Library/LaunchAgents`.
 * - launchd runs `ProgramArguments` directly (no shell), so there is no shell
 *   metacharacter injection surface.
 */

import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';

/** Default reverse-DNS launchd label for the resident service. */
export const DEFAULT_SERVICE_LABEL = 'com.codeexecutor.mcp';

/** Everything needed to render the resident-service plist. */
export interface ResidentServiceSpec {
  /** Absolute path to the executable launchd should run (the compiled binary). */
  programPath: string;
  /** Environment variables baked into the plist (role, port, token, config…). */
  env: Record<string, string>;
  /** Absolute path for the service's stdout log. */
  stdoutPath: string;
  /** Absolute path for the service's stderr log. */
  stderrPath: string;
}

/** Runs `launchctl <args>`, resolving on exit 0 and rejecting otherwise. */
export type LaunchctlRunner = (args: string[]) => Promise<void>;

export interface LaunchdServiceOptions {
  /** launchd label (also the plist basename). Default {@link DEFAULT_SERVICE_LABEL}. */
  label?: string;
  /** LaunchAgents directory. Default `~/Library/LaunchAgents` (override in tests). */
  launchAgentsDir?: string;
  /** GUI domain uid for `launchctl`. Default the current user's uid. */
  uid?: number;
  /** Host platform. Default `process.platform` (override in tests). */
  platform?: NodeJS.Platform;
  /** launchctl runner. Default spawns the real `launchctl` (override in tests). */
  runLaunchctl?: LaunchctlRunner;
}

/** Escape a string for safe inclusion in a plist XML text node. */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export class LaunchdService {
  private readonly label: string;
  private readonly launchAgentsDir: string;
  private readonly plistPath: string;
  private readonly uid: number;
  private readonly platform: NodeJS.Platform;
  private readonly runLaunchctl: LaunchctlRunner;

  constructor(options: LaunchdServiceOptions = {}) {
    this.label = options.label ?? DEFAULT_SERVICE_LABEL;

    // Restrict the label to a safe charset (reverse-DNS style). This also makes
    // path traversal in the plist path impossible — no `/`, so no `../`.
    if (!/^[a-zA-Z0-9_.-]+$/.test(this.label)) {
      throw new Error(
        'Service label must contain only alphanumerics, hyphens, underscores, and dots'
      );
    }

    this.launchAgentsDir =
      options.launchAgentsDir ?? path.join(os.homedir(), 'Library', 'LaunchAgents');
    this.plistPath = path.join(this.launchAgentsDir, `${this.label}.plist`);

    // Defense-in-depth: the plist must stay inside the LaunchAgents directory.
    if (!this.plistPath.startsWith(this.launchAgentsDir + path.sep)) {
      throw new Error('Path traversal detected in service label');
    }

    this.uid = options.uid ?? os.userInfo().uid;
    this.platform = options.platform ?? process.platform;
    this.runLaunchctl = options.runLaunchctl ?? ((args) => this.defaultRunLaunchctl(args));
  }

  /** The launchd label / plist basename. */
  get serviceLabel(): string {
    return this.label;
  }

  /** Absolute path of the managed plist. */
  get plistFilePath(): string {
    return this.plistPath;
  }

  /** The `gui/<uid>` service-target domain used by modern launchctl verbs. */
  private get domainTarget(): string {
    return `gui/${this.uid}`;
  }

  /** The `gui/<uid>/<label>` service target for a specific service. */
  private get serviceTarget(): string {
    return `gui/${this.uid}/${this.label}`;
  }

  private assertMacos(): void {
    if (this.platform !== 'darwin') {
      throw new Error(
        `The resident launchd service is macOS-only (current platform: ${this.platform}).`
      );
    }
  }

  /**
   * Render the resident-service plist XML. Pure — no side effects — so it is
   * unit-testable and reused by {@link install}.
   */
  generatePlist(spec: ResidentServiceSpec): string {
    const programArgs = [spec.programPath]
      .map((arg) => `        <string>${escapeXml(arg)}</string>`)
      .join('\n');

    const envEntries = Object.entries(spec.env)
      .map(
        ([key, value]) =>
          `        <key>${escapeXml(key)}</key>\n        <string>${escapeXml(value)}</string>`
      )
      .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${escapeXml(this.label)}</string>

    <key>ProgramArguments</key>
    <array>
${programArgs}
    </array>

    <key>EnvironmentVariables</key>
    <dict>
${envEntries}
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <key>KeepAlive</key>
    <true/>

    <key>ProcessType</key>
    <string>Background</string>

    <key>StandardOutPath</key>
    <string>${escapeXml(spec.stdoutPath)}</string>

    <key>StandardErrorPath</key>
    <string>${escapeXml(spec.stderrPath)}</string>
</dict>
</plist>
`;
  }

  /**
   * Write the plist (`0600`) and (re)load the service.
   *
   * Idempotent: if the service is already loaded it is booted out first so the
   * new plist takes effect, then bootstrapped.
   */
  async install(spec: ResidentServiceSpec): Promise<void> {
    this.assertMacos();

    if (!path.isAbsolute(spec.programPath)) {
      throw new Error('programPath must be absolute');
    }

    await fs.mkdir(this.launchAgentsDir, { recursive: true });
    // 0600 — the plist embeds the bearer token in EnvironmentVariables.
    await fs.writeFile(this.plistPath, this.generatePlist(spec), { mode: 0o600 });

    // Reload cleanly: booting out a not-loaded service is an expected no-op.
    try {
      await this.runLaunchctl(['bootout', this.serviceTarget]);
    } catch {
      // Not currently loaded — fine.
    }
    await this.runLaunchctl(['bootstrap', this.domainTarget, this.plistPath]);
  }

  /**
   * Unload the service and remove its plist. Resilient — does not throw if the
   * service is not loaded or the plist is already gone.
   */
  async uninstall(): Promise<void> {
    this.assertMacos();

    try {
      await this.runLaunchctl(['bootout', this.serviceTarget]);
    } catch {
      // Not loaded — continue to file removal.
    }
    try {
      await fs.unlink(this.plistPath);
    } catch {
      // Already removed — nothing to do.
    }
  }

  /** Restart the running service in place (`launchctl kickstart -k`). */
  async restart(): Promise<void> {
    this.assertMacos();
    await this.runLaunchctl(['kickstart', '-k', this.serviceTarget]);
  }

  /** Whether launchd currently has the service loaded. */
  async isLoaded(): Promise<boolean> {
    try {
      await this.runLaunchctl(['print', this.serviceTarget]);
      return true;
    } catch {
      return false;
    }
  }

  /** Whether the managed plist file exists on disk. */
  async plistExists(): Promise<boolean> {
    try {
      await fs.access(this.plistPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Default launchctl runner: spawn `launchctl` directly (no shell) and reject
   * with the captured stderr/stdout on a non-zero exit.
   */
  private defaultRunLaunchctl(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn('launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'] });

      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(
            new Error(
              `launchctl ${args.join(' ')} failed (exit ${code}): ${stderr.trim() || stdout.trim()}`
            )
          );
        }
      });

      proc.on('error', (error) => {
        reject(new Error(`Failed to execute launchctl: ${error.message}. Is launchd available?`));
      });
    });
  }
}
