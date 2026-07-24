/**
 * Minimal downstream STDIO MCP server used by the orphan-cleanup integration
 * test. It connects over stdio (so the code-executor binary tracks it as a real
 * spawned child) and then stays alive, writing its PID to FAKE_MCP_PID_FILE once
 * connected so the test can track and assert on it.
 *
 * Set FAKE_MCP_IGNORE_SIGTERM=1 to make it ignore SIGTERM, which forces the
 * SIGKILL-escalation branch of killProcessGracefully().
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { writeFileSync } from 'node:fs';

if (process.env.FAKE_MCP_IGNORE_SIGTERM === '1') {
  // Swallow SIGTERM so the parent must escalate to SIGKILL to reap us.
  process.on('SIGTERM', () => {});
}

const server = new McpServer({ name: 'fake-mcp', version: '1.0.0' });
server.registerTool(
  'noop',
  { description: 'No-op tool so tools/list is non-empty during the handshake.' },
  async () => ({ content: [{ type: 'text', text: 'ok' }] })
);

const transport = new StdioServerTransport();
await server.connect(transport);

// Announce readiness + PID only AFTER the handshake transport is connected, so
// the test proceeds once we are a tracked downstream child of the binary.
const pidFile = process.env.FAKE_MCP_PID_FILE;
if (pidFile) {
  writeFileSync(pidFile, String(process.pid));
}
