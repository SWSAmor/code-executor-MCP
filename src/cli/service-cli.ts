/**
 * `code-executor-mcp service <install|uninstall|status|restart>` — manage the
 * resident launchd service that runs the single shared HTTP MCP endpoint.
 *
 * This is the minimal, local-plist lifecycle (PR2): enough to install a working
 * resident service and point a host at it. Homebrew / `brew services` wrapping,
 * host-config rewiring (`configure-hosts`), and token rotation are later PRs.
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { LaunchdService } from '../service/launchd-service.js';
import { ensureHttpToken, getHttpTokenPath } from '../service/http-token.js';
import { getHttpPort, getHttpHost } from '../config/loader.js';

const USAGE =
  'Usage: code-executor-mcp service <install|uninstall|status|restart> ' +
  '[--port N] [--config PATH] [--binary PATH] [--no-auth]';

interface ServiceFlags {
  port?: number;
  config?: string;
  binary?: string;
  auth: boolean; // default: true (auth on)
}

/** Parse the flag subset the service command accepts. Throws on anything else. */
function parseFlags(args: string[]): ServiceFlags {
  const flags: ServiceFlags = { auth: true };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case '--port':
        flags.port = parseInt(args[++i] ?? '', 10);
        break;
      case '--config':
        flags.config = args[++i];
        break;
      case '--binary':
        flags.binary = args[++i];
        break;
      case '--no-auth':
        flags.auth = false;
        break;
      default:
        throw new Error(`Unknown flag: ${arg}\n${USAGE}`);
    }
  }
  if (flags.port !== undefined && (isNaN(flags.port) || flags.port < 1024 || flags.port > 65535)) {
    throw new Error('--port must be an integer between 1024 and 65535');
  }
  return flags;
}

/** Build the launchd EnvironmentVariables and install + load the service. */
async function doInstall(service: LaunchdService, flags: ServiceFlags): Promise<void> {
  // The compiled binary invoking this command is exactly what launchd should run.
  const programPath = path.resolve(flags.binary ?? process.execPath);
  const port = flags.port ?? getHttpPort();
  const host = getHttpHost();
  const logDir = path.join(os.homedir(), 'Library', 'Logs');

  const env: Record<string, string> = {
    CODE_EXECUTOR_ROLE: 'http',
    CODE_EXECUTOR_HTTP_PORT: String(port),
    // The single-instance model structurally prevents the fork-bomb the ancestry
    // guard defends against, and launchd (not a parent code-executor) launches
    // this process — so allow it to build the downstream pool.
    CODE_EXECUTOR_ALLOW_NESTED: '1',
  };

  const configPath = flags.config ?? process.env.MCP_CONFIG_PATH;
  if (configPath) {
    env.MCP_CONFIG_PATH = path.resolve(configPath);
  }

  let token: string | undefined;
  if (flags.auth) {
    token = await ensureHttpToken();
    env.CODE_EXECUTOR_HTTP_TOKEN = token;
  } else {
    env.CODE_EXECUTOR_HTTP_AUTH = 'off';
  }

  await service.install({
    programPath,
    env,
    stdoutPath: path.join(logDir, 'code-executor-mcp.log'),
    stderrPath: path.join(logDir, 'code-executor-mcp.error.log'),
  });

  console.log(`✅ Installed and loaded launchd service "${service.serviceLabel}"`);
  console.log(`   Binary  : ${programPath}`);
  console.log(`   Endpoint: http://${host}:${port}/mcp`);
  if (configPath) {
    console.log(`   Config  : ${env.MCP_CONFIG_PATH}`);
  }
  if (token) {
    console.log(`   Auth    : Bearer token (stored 0600 at ${getHttpTokenPath()})`);
    console.log('');
    console.log('   Point an MCP host at it with:');
    console.log(`     url    : http://${host}:${port}/mcp`);
    console.log(`     header : Authorization: Bearer ${token}`);
  } else {
    console.log('   Auth    : OFF (CODE_EXECUTOR_HTTP_AUTH=off)');
  }
}

/** Print installed / loaded / health status. */
async function doStatus(service: LaunchdService): Promise<void> {
  const plistPresent = await service.plistExists();
  const loaded = await service.isLoaded();
  const host = getHttpHost();
  const port = getHttpPort();

  console.log(`Service : ${service.serviceLabel}`);
  console.log(`Plist   : ${plistPresent ? service.plistFilePath : '(not installed)'}`);
  console.log(`Loaded  : ${loaded ? 'yes' : 'no'}`);

  // Best-effort readiness probe against the default/env port (the installed
  // plist may use a different port; this reports what is reachable now).
  try {
    const res = await fetch(`http://${host}:${port}/health`);
    if (res.ok) {
      const body = (await res.json()) as { sessions?: number; version?: string };
      console.log(`Health  : ok (sessions: ${body.sessions ?? '?'}, v${body.version ?? '?'})`);
    } else {
      console.log(`Health  : HTTP ${res.status}`);
    }
  } catch {
    console.log(`Health  : unreachable at http://${host}:${port}/health`);
  }
}

/**
 * Entry point for the `service` subcommand. Handles its own process exit so the
 * caller (src/index.ts) does not need to.
 */
export async function runServiceCli(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  const service = new LaunchdService();

  try {
    switch (sub) {
      case 'install':
        await doInstall(service, parseFlags(rest));
        break;
      case 'uninstall':
        await service.uninstall();
        console.log(`✅ Uninstalled launchd service "${service.serviceLabel}"`);
        break;
      case 'restart':
        await service.restart();
        console.log(`✅ Restarted launchd service "${service.serviceLabel}"`);
        break;
      case 'status':
        await doStatus(service);
        break;
      default:
        console.error(USAGE);
        process.exit(2);
    }
    process.exit(0);
  } catch (error) {
    console.error(
      `❌ service ${sub ?? ''} failed: ${error instanceof Error ? error.message : String(error)}`
    );
    process.exit(1);
  }
}
