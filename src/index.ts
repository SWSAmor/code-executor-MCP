#!/usr/bin/env node

/**
 * Code Executor MCP Server
 *
 * Progressive disclosure MCP server that executes TypeScript/Python code
 * with integrated MCP client access.
 *
 * Reduces token usage by ~98% by exposing only 2 tools instead of 47.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { getParentPollIntervalMs } from './config/loader.js';
import { watchClientDisconnect } from './mcp/stdin-watcher.js';
import { watchParentExit } from './mcp/parent-watcher.js';
import { redirectConsoleLogToStderr } from './utils/stdio-guard.js';
import { VERSION } from './version.js';
import { detectMCPConfigLocation, getToolDisplayName } from './cli/config-location-detector.js';
import { SharedCore, registerTools } from './core/shared-core.js';

/**
 * Main server class (stdio transport)
 *
 * Thin wrapper over {@link SharedCore}: builds the shared, transport-agnostic
 * components once and registers the tool set on the stdio `McpServer`. All
 * shared behavior lives in SharedCore so a future HTTP transport can reuse it;
 * this class owns only the stdio-specific concerns (transport, disconnect /
 * parent-death watchers, and process exit).
 */
class CodeExecutorServer {
  private core: SharedCore;
  private server: McpServer;
  // Halts the active parent-liveness poll (see start()). Null until start() wires it.
  private stopParentWatch: (() => void) | null = null;
  // Guards process exit against concurrent shutdown triggers (signal-handler
  // races, or a signal racing the stdin/parent watchers). The original class
  // used a single shutdown() whose in-progress guard ensured only the FIRST
  // trigger drained-then-exited while later triggers were ignored; keeping that
  // here preserves that behavior so the graceful drain is never cut short by a
  // duplicate trigger reaching process.exit.
  private shuttingDown = false;

  constructor() {
    // Build the shared core (downstream MCP pool, validators, connection pool).
    this.core = new SharedCore();

    // Initialize MCP server
    this.server = new McpServer({
      name: 'code-executor-mcp-server',
      version: VERSION,
    });
  }

  /**
   * Start server
   *
   * Errors are propagated to caller for proper error handling.
   */
  async start(): Promise<void> {
    // Pre-tools shared setup: load config, detect Deno, init rate limiter.
    await this.core.initialize();

    // Register tools (now that config is initialized and Deno checked)
    registerTools(this.core, this.server);

    // Start stdio transport FIRST so the upstream MCP handshake (initialize +
    // tools/list) is answered immediately. The downstream client pool is then
    // initialized in the BACKGROUND. This decouples our own readiness from the
    // health of downstream servers: a slow/unreachable server can no longer
    // delay startup past the host's timeout and trigger a respawn loop.
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    // Shut down when the MCP host disconnects. The host's exit closes our stdin
    // pipe (EOF); on macOS that is the only signal we get that the parent is
    // gone (no death signal is delivered to children), and the SDK transport
    // does not act on it. Without this the server and every downstream MCP
    // child it spawned orphan after the host exits. See stdin-watcher.ts.
    watchClientDisconnect(process.stdin, (reason) => {
      console.error(`stdin ${reason} — MCP client disconnected, initiating shutdown...`);
      void this.shutdown().catch((error) => {
        console.error('Error during disconnect-triggered shutdown:', error);
        process.exit(1);
      });
    });

    // Belt-and-suspenders to the stdin watcher above: actively poll parent
    // liveness. stdin EOF can fail to arrive (host SIGKILLed, or a wrapper/child
    // holds our stdin pipe open), and then the poll is the only signal that the
    // host is gone. On POSIX, parent death reparents us to PID 1; that is what we
    // watch for. See parent-watcher.ts.
    const initialPpid = process.ppid;
    this.stopParentWatch = watchParentExit({
      getPpid: () => process.ppid,
      initialPpid,
      intervalMs: getParentPollIntervalMs(),
      isPosix: process.platform !== 'win32',
      onParentExit: (reason) => {
        console.error(`Parent process gone (${reason}) — initiating shutdown...`);
        void this.shutdown().catch((error) => {
          console.error('Error during parent-exit-triggered shutdown:', error);
          process.exit(1);
        });
      },
    });

    console.error('Code Executor MCP Server started successfully (downstream MCP pool initializing in background)');

    // Post-transport background services: downstream MCP client pool (kicked off
    // in the background, not awaited) and the optional health-check server.
    await this.core.startBackgroundServices();
  }

  /**
   * Synchronously kill all spawned downstream child processes.
   * Backstop for the process 'exit' handler (see bottom of file).
   */
  killChildrenSync(): void {
    this.core.killChildrenSync();
  }

  /**
   * Shutdown server, then exit the process.
   *
   * Delegates the graceful, transport-agnostic drain to SharedCore and owns the
   * stdio-specific concerns: stopping the parent-liveness poll and terminating
   * the process once the drain completes.
   */
  async shutdown(): Promise<void> {
    // Preserve the original single-guard shutdown semantics: concurrent
    // triggers (signal-handler races, or a signal racing the stdin/parent
    // watchers) must NOT each drive process.exit. The first trigger drains
    // gracefully then exits; duplicates are ignored. Without this guard the
    // SharedCore in-progress guard would early-return on a duplicate and this
    // wrapper would then call process.exit(0) mid-drain.
    if (this.shuttingDown) {
      console.error('Shutdown already in progress - ignoring duplicate call');
      return;
    }
    this.shuttingDown = true;

    // Stop the parent-liveness poll — shutdown is underway (its internal guard
    // also fires onParentExit at most once, so this is hygiene, not correctness).
    if (this.stopParentWatch) {
      this.stopParentWatch();
      this.stopParentWatch = null;
    }

    await this.core.shutdown();

    process.exit(0);
  }
}

// Export functions for testing
export { executeTypescriptInSandbox as executeTypescript } from './executors/sandbox-executor.js';
// Pyodide export kept as a type-only re-export at the top of this file; consumers
// who need the runtime should `import('code-executor-mcp/dist/executors/pyodide-executor.js')`
// directly. Avoiding a static re-export keeps pyodide out of `bun --compile` graphs.

// Start server
const server = new CodeExecutorServer();

// P1: Graceful shutdown signal handlers (flag now in CodeExecutorServer class)
const handleShutdownSignal = async (signal: string) => {
  console.error(`Received ${signal}, initiating graceful shutdown...`);

  try {
    await server.shutdown(); // Internal flag protects against concurrent calls
  } catch (error) {
    console.error('Error during shutdown:', error);
    process.exit(1);
  }
};

process.on('SIGINT', () => void handleShutdownSignal('SIGINT'));
process.on('SIGTERM', () => void handleShutdownSignal('SIGTERM'));
// SIGHUP: controlling terminal / session leader went away (a common parent-death
// signal). Treat it as a graceful shutdown rather than the default (terminate).
process.on('SIGHUP', () => void handleShutdownSignal('SIGHUP'));

// Synchronous last-resort cleanup. If the process exits without the async
// graceful path completing (e.g. host sends SIGKILL after a timeout, or an
// unexpected exit), this guarantees spawned downstream MCP children are killed
// rather than left as orphans. Must be synchronous — no async work runs here.
process.on('exit', () => {
  try {
    server.killChildrenSync();
  } catch {
    // Nothing actionable during exit.
  }
});

// Argument parsing: Handle CLI commands
const args = process.argv.slice(2);
const command = args[0];

if (command === 'setup') {
  // Run setup wizard instead of starting server
  console.error('🚀 Launching setup wizard...\n');

  // Dynamically import and run the CLI wizard
  import('./cli/index.js')
    .then(() => {
      // CLI wizard handles its own exit
    })
    .catch((error) => {
      console.error('❌ Setup wizard failed:', error);
      process.exit(1);
    });
} else if (command === 'sync-wrappers') {
  // Run daily sync service
  console.error('🔄 Running wrapper sync...\n');

  // Dynamically import and run the sync CLI
  import('./cli/sync-wrappers-cli.js')
    .then(() => {
      // Sync CLI handles its own exit
    })
    .catch((error) => {
      console.error('❌ Wrapper sync failed:', error);
      process.exit(1);
    });
} else {
  // Normal server startup flow (stdio MCP server).
  //
  // Reroute console.log/info/debug to stderr BEFORE any server code runs. On
  // stdio, stdout is the JSON-RPC channel; a stray console.log corrupts it and
  // strict hosts (e.g. Claude Desktop) reject the stream. See stdio-guard.ts.
  // Scoped to server mode only — the CLI subcommands above keep stdout.
  redirectConsoleLogToStderr();

  (async () => {
    try {
      const location = await detectMCPConfigLocation();

      if (!location.exists) {
        // No configuration found - show instructions and exit
        const toolName = getToolDisplayName(location.tool);

        console.error('');
        console.error('❌ No MCP configuration found');
        console.error('');
        console.error('📝 To configure code-executor-mcp, run:');
        console.error('   code-executor-mcp setup');
        console.error('');
        console.error(`Configuration will be created at: ${location.path}`);
        console.error(`For tool: ${toolName}`);
        console.error('');

        process.exit(1);
      }

      // Configuration exists - start server
      await server.start();
    } catch (error) {
      console.error('Fatal error:', error);
      process.exit(1);
    }
  })();
}
