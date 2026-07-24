/**
 * Streamable HTTP MCP server — the single-shared-instance transport.
 *
 * WHY: over stdio, every MCP host spawns its own code-executor child, and each
 * one independently spawns the whole downstream MCP pool (the "thundering
 * herd"). In HTTP mode a single resident process serves one Streamable HTTP
 * endpoint on loopback that every host connects to via a `url`, so the
 * expensive downstream pool is built ONCE for the machine.
 *
 * The shared, transport-agnostic state (downstream pool, validators, connection
 * pool) lives in a single {@link SharedCore}; each connected host gets its own
 * MCP session — a fresh `McpServer` bound to a per-session
 * `StreamableHTTPServerTransport` — so request/response id spaces are isolated
 * and server→client requests (sampling / elicitation / roots) route back to the
 * originating host automatically (the SDK routes them over that session's
 * transport). All sessions share the one SharedCore.
 *
 * Security: bound to 127.0.0.1 only; every /mcp request requires a bearer token
 * (a code-execution endpoint on a TCP port is reachable by any local process and,
 * via DNS-rebinding, by browsers — so auth is on by default), and the SDK's DNS
 * rebinding protection validates the Host header. Auth may be disabled only via
 * CODE_EXECUTOR_HTTP_AUTH=off on a trusted single-user machine.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { SharedCore, registerTools } from '../core/shared-core.js';
import {
  getHttpPort,
  getHttpHost,
  isHttpAuthEnabled,
  getHttpAuthToken,
} from '../config/loader.js';
import { VERSION } from '../version.js';

const MCP_PATH = '/mcp';
const HEALTH_PATH = '/health';
const MAX_BODY_BYTES = 4 * 1024 * 1024; // cap the initialize-body read (SDK bounds the rest)

/** Write a JSON body with a status code. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

/** Write a JSON-RPC error envelope (the shape MCP clients expect). */
function sendRpcError(res: ServerResponse, status: number, message: string, code = -32000): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null });
}

/** Constant-time bearer-token check. */
function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') {
    return false;
  }
  const provided = Buffer.from(header);
  const expected = Buffer.from(`Bearer ${expectedToken}`);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** Read and JSON-parse a request body (used only for the session-less initialize). */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) {
      throw new Error('Request body too large');
    }
    chunks.push(chunk as Buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
}

/**
 * Run the single shared HTTP MCP server. Never returns (owns the process
 * lifecycle); resolves only if `listen` fails before startup.
 */
export async function runHttpServer(): Promise<void> {
  const authEnabled = isHttpAuthEnabled();
  const token = getHttpAuthToken();
  if (authEnabled && !token) {
    console.error('FATAL: HTTP auth is enabled but CODE_EXECUTOR_HTTP_TOKEN is not set.');
    console.error('Set a bearer token, or set CODE_EXECUTOR_HTTP_AUTH=off on a trusted single-user machine.');
    process.exit(1);
  }

  // Build the shared, transport-agnostic core ONCE (config, Deno, rate limiter),
  // then kick off the downstream pool + health server. All sessions share it.
  const core = new SharedCore();
  await core.initialize();
  await core.startBackgroundServices();

  const port = getHttpPort();
  const host = getHttpHost();
  const allowedHosts = [`${host}:${port}`, `localhost:${port}`];

  // One transport (+ its own McpServer) per live MCP session, keyed by session id.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  /** Create a fresh per-session transport + McpServer sharing the one core. */
  async function openSession(): Promise<StreamableHTTPServerTransport> {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      enableDnsRebindingProtection: true,
      allowedHosts,
      onsessioninitialized: (id) => {
        sessions.set(id, transport);
        console.error(`MCP session opened: ${id} (active: ${sessions.size})`);
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        console.error(`MCP session closed: ${id} (active: ${sessions.size})`);
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) {
        sessions.delete(transport.sessionId);
      }
    };

    const server = new McpServer({ name: 'code-executor-mcp-server', version: VERSION });
    registerTools(core, server);
    // Must finish connecting (wires onmessage + starts the transport) BEFORE the
    // initialize message is handled, or the first message would be dropped.
    await server.connect(transport);
    return transport;
  }

  const httpServer = createServer((req, res) => {
    void handleHttp(req, res).catch((error) => {
      console.error('HTTP request error:', error);
      if (!res.headersSent) {
        sendRpcError(res, 500, 'Internal server error');
      }
    });
  });

  async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${host}:${port}`);

    // Unauthenticated readiness probe for cectl / launchd (no code execution).
    if (req.method === 'GET' && url.pathname === HEALTH_PATH) {
      sendJson(res, 200, { healthy: true, sessions: sessions.size, version: VERSION });
      return;
    }

    if (url.pathname !== MCP_PATH) {
      sendRpcError(res, 404, 'Not found');
      return;
    }

    if (authEnabled && !isAuthorized(req, token as string)) {
      res
        .writeHead(401, { 'Content-Type': 'application/json', 'WWW-Authenticate': 'Bearer' })
        .end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Unauthorized' }, id: null }));
      return;
    }

    const sessionId = req.headers['mcp-session-id'];
    const existing = typeof sessionId === 'string' ? sessions.get(sessionId) : undefined;

    if (req.method === 'POST') {
      if (existing) {
        // Established session — let the SDK read/handle the body.
        await existing.handleRequest(req, res);
        return;
      }
      if (typeof sessionId === 'string') {
        // A session id was presented but we do not know it (expired / restarted).
        sendRpcError(res, 404, 'Unknown or expired session — re-initialize');
        return;
      }
      // No session id: only an initialize request may open a new session.
      let body: unknown;
      try {
        body = await readJsonBody(req);
      } catch {
        sendRpcError(res, 400, 'Invalid JSON body');
        return;
      }
      if (!isInitializeRequest(body)) {
        sendRpcError(res, 400, 'Missing Mcp-Session-Id (only an initialize request may omit it)');
        return;
      }
      const transport = await openSession();
      await transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      // SSE stream (GET) or explicit session close (DELETE) — both require a known session.
      if (!existing) {
        sendRpcError(res, 404, 'Unknown or expired session — re-initialize');
        return;
      }
      await existing.handleRequest(req, res);
      return;
    }

    sendRpcError(res, 405, 'Method not allowed');
  }

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });
  console.error(
    `Code Executor MCP HTTP server listening on http://${host}:${port}${MCP_PATH} (auth: ${authEnabled ? 'on' : 'OFF'})`
  );

  // Lifecycle: on a signal, stop accepting connections, close every session, then
  // drain the shared core and exit. launchd restarts the process on the next need.
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.error(`Received ${signal}, shutting down HTTP server...`);
    httpServer.close();
    for (const transport of sessions.values()) {
      try {
        await transport.close();
      } catch {
        // best effort — the core drain + exit backstop below still runs
      }
    }
    sessions.clear();
    await core.shutdown();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGHUP', () => void shutdown('SIGHUP'));
  // Synchronous last-resort cleanup so a hard exit never orphans downstream children.
  process.on('exit', () => {
    try {
      core.killChildrenSync();
    } catch {
      // Nothing actionable during exit.
    }
  });
}
