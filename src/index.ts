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
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { initConfig, isPythonEnabled, isRateLimitEnabled, getRateLimitConfig, shouldSkipDangerousPatternCheck } from './config/loader.js';
import { ExecuteTypescriptInputSchema, ExecutePythonInputSchema, ExecutionResultSchema } from './config/schemas.js';
import { MCPClientPool } from './mcp/client-pool.js';
import { SecurityValidator } from './validation/security-validator.js';
import { ConnectionPool } from './mcp/connection-pool.js';
import { RateLimiter } from './security/rate-limiter.js';
import { executeTypescriptInSandbox } from './executors/sandbox-executor.js';
import { executePythonInSandbox as executePythonNative } from './executors/python-executor.js';
// Pyodide is loaded lazily — only imported when PYTHON_SANDBOX_READY=true.
// This keeps the 13MB pyodide WASM out of `bun --compile` binaries that don't need it.
type ExecutePythonPyodideFn = typeof import('./executors/pyodide-executor.js').executePythonInSandbox;
import { formatErrorResponse, formatExecutionResultForCli } from './utils/utils.js';
import { ErrorType } from './types.js';
import { checkDenoAvailable, getDenoVersion, getDenoInstallMessage } from './executors/deno-checker.js';
import { HealthCheckServer } from './core/server/health-check.js';
import { VERSION } from './version.js';
import type { MCPExecutionResult } from './types.js';
import { detectMCPConfigLocation, getToolDisplayName } from './cli/config-location-detector.js';

/**
 * Health check response schema (Zod)
 * Used as outputSchema for the health tool
 */
const HealthCheckOutputSchema = z.object({
  healthy: z.boolean().describe('Overall health status'),
  auditLog: z.object({
    enabled: z.boolean().describe('Audit logging enabled'),
  }).describe('Audit log configuration'),
  mcpClients: z.object({
    connected: z.number().describe('Number of connected MCP tools'),
  }).describe('MCP client connections'),
  connectionPool: z.object({
    active: z.number().describe('Active concurrent executions'),
    waiting: z.number().describe('Queued executions waiting'),
    max: z.number().describe('Maximum concurrent limit'),
  }).describe('Connection pool status'),
  uptime: z.number().describe('Server uptime in seconds'),
  timestamp: z.string().describe('ISO 8601 timestamp'),
});

/**
 * Main server class
 */
class CodeExecutorServer {
  private server: McpServer;
  private mcpClientPool: MCPClientPool;
  private securityValidator: SecurityValidator;
  private connectionPool: ConnectionPool;
  private rateLimiter: RateLimiter | null = null;
  private denoAvailable: boolean = false;
  private healthCheckServer: HealthCheckServer | null = null;
  private shutdownInProgress = false; // P1: Prevent concurrent shutdown attempts
  // Resolves when the downstream MCP client pool has finished initializing.
  // The pool is initialized in the BACKGROUND (see start()) so the upstream MCP
  // handshake is never blocked by slow/unreachable downstream servers. Tool
  // handlers await this before executing so downstream tools are ready (or have
  // been determined unavailable) by the time code runs.
  private poolReady: Promise<void> = Promise.resolve();

  constructor() {
    // Initialize MCP server
    this.server = new McpServer({
      name: 'code-executor-mcp-server',
      version: VERSION,
    });

    // Initialize components
    this.mcpClientPool = new MCPClientPool();
    this.securityValidator = new SecurityValidator();
    this.connectionPool = new ConnectionPool(100); // Max 100 concurrent executions

    // Rate limiter will be initialized after config is loaded
    this.rateLimiter = null;

    // Deno availability checked in start()
    this.denoAvailable = false;

    // Health check server will be initialized in start()
    this.healthCheckServer = null;

    // Note: registerTools() is called in start() after config initialization
  }

  /**
   * Handle tool execution errors with standardized response format
   */
  private handleToolError(error: unknown, errorType: ErrorType) {
    const errorResponse = formatErrorResponse(error, errorType);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify(errorResponse, null, 2),
      }],
      isError: true,
    };
  }

  /**
   * Check rate limit before executing code
   *
   * Returns error response if rate limited, null otherwise.
   */
  private async checkRateLimit(): Promise<ReturnType<typeof this.handleToolError> | null> {
    if (!this.rateLimiter) {
      return null; // Rate limiting disabled
    }

    // Use 'default' as client ID since MCP servers run locally
    // In a networked environment, this would be the client IP
    const result = await this.rateLimiter.checkLimit('default');

    if (!result.allowed) {
      const error = new Error(
        `Rate limit exceeded. Maximum ${getRateLimitConfig()?.maxRequests ?? 30} requests per ` +
        `${(getRateLimitConfig()?.windowMs ?? 60000) / 1000}s. ` +
        `Try again in ${Math.ceil(result.resetIn / 1000)}s.`
      );
      return this.handleToolError(error, ErrorType.VALIDATION);
    }

    return null;
  }


  /**
   * Register MCP tools
   */
  private registerTools(): void {
    // Tool 1: Execute TypeScript (only if Deno is available)
    if (this.denoAvailable) {
      const typescriptToolConfig: Parameters<McpServer['registerTool']>[1] = {
        title: 'Execute TypeScript with MCP Access',
        description: `Execute TypeScript/JavaScript code in a secure Deno sandbox with access to MCP tools.

Executed code has access to callMCPTool(toolName, params) function for calling other MCP servers.
Import DopaMind wrappers: import { codereview } from './servers/zen/codereview'

**NEW: In-Sandbox Tool Discovery**
Three discovery functions are injected into the sandbox for self-service tool exploration:

1. discoverMCPTools(options?) - Discover all available MCP tools
   - Options: { search?: string[] } - Array of keywords to filter tools (OR logic)
   - Returns: ToolSchema[] - Array of tool schemas
   - Example: const tools = await discoverMCPTools({ search: ['file', 'read'] });

2. getToolSchema(toolName) - Get detailed schema for a specific tool
   - Parameter: toolName (string) - Full tool name (e.g., 'mcp__filesystem__read_file')
   - Returns: ToolSchema | null - Tool schema or null if not found
   - Example: const schema = await getToolSchema('mcp__filesystem__read_file');

3. searchTools(query, limit?) - Search tools by keywords with result limiting
   - Parameters: query (string), limit (number, default: 10)
   - Returns: ToolSchema[] - Filtered and limited tool schemas
   - Example: const fileTools = await searchTools('file read write', 5);

**Proactive Workflow Example:**
// Discover tools, inspect schema, then execute
const networkTools = await searchTools('fetch url');
const schema = await getToolSchema(networkTools[0].name);
const result = await callMCPTool(networkTools[0].name, { url: 'https://...' });

Security:
- Only tools in allowedTools array can be called
- Deno sandbox permissions enforce file system and network restrictions
- Execution timeout prevents infinite loops
- All executions are audit logged

Args:
  - code (string): TypeScript/JavaScript code to execute
  - allowedTools (string[]): MCP tools whitelist (default: [])
    Format: ['mcp__<server>__<tool>', ...]
    Example: ['mcp__zen__codereview', 'mcp__filesystem__read_file']
  - timeoutMs (number): Execution timeout in milliseconds (default: 30000)
  - permissions (object): Deno sandbox permissions
    - read (string[]): Allowed read paths
    - write (string[]): Allowed write paths
    - net (string[]): Allowed network hosts
  - skipDangerousPatternCheck (boolean): Skip dangerous pattern validation (optional, default: false)
    Can be overridden by CODE_EXECUTOR_SKIP_DANGEROUS_PATTERNS env var or config file
    NOTE: Dangerous pattern validation is defense-in-depth only, NOT a security boundary
    Real security comes from sandbox permissions, resource limits, and process isolation

Returns:
  {
    "success": boolean,
    "output": string,           // stdout from console.log()
    "error": string,            // Error message if failed
    "executionTimeMs": number,
    "toolCallsMade": string[],  // MCP tools called
    "toolCallSummary": ToolCallSummaryEntry[] // Aggregated tool call metrics
  }

Example:
  {
    "code": "const result = await callMCPTool('mcp__zen__codereview', {...}); console.log(result);",
    "allowedTools": ["mcp__zen__codereview"],
    "timeoutMs": 60000
  }`,
        inputSchema: {
          code: z.string().min(1).describe('TypeScript/JavaScript code to execute'),
          allowedTools: z.array(z.string()).default([]).describe('MCP tools whitelist'),
          timeoutMs: z.number().int().min(1000).default(30000).describe('Timeout in milliseconds'),
          permissions: z.object({
            read: z.array(z.string()).optional(),
            write: z.array(z.string()).optional(),
            net: z.array(z.string()).optional(),
          }).default({}).describe('Deno sandbox permissions'),
          skipDangerousPatternCheck: z.boolean().optional().describe('Skip dangerous pattern validation (defense-in-depth only)'),
          enableSampling: z.boolean().optional().default(false).describe('Enable LLM sampling (llm.ask/llm.think helpers)'),
          maxSamplingRounds: z.number().int().min(1).max(100).optional().default(10).describe('Max sampling rounds'),
          maxSamplingTokens: z.number().int().min(100).max(100000).optional().default(10000).describe('Max sampling tokens'),
          samplingSystemPrompt: z.string().optional().describe('Custom system prompt for sampling'),
          allowedSamplingModels: z.array(z.string()).optional().describe('Allowed Claude models for sampling'),
        },
        outputSchema: ExecutionResultSchema.shape,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      };

      const typescriptToolHandler: Parameters<McpServer['registerTool']>[2] = async (args: any, extra: RequestHandlerExtra<any, any>) => {
        try {
          // Check rate limit
          const rateLimitError = await this.checkRateLimit();
          if (rateLimitError) {
            return rateLimitError;
          }

          // Validate input with Zod schema (runtime validation)
          const parseResult = ExecuteTypescriptInputSchema.safeParse(args);
          if (!parseResult.success) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  output: '',
                  error: `Input validation failed: ${parseResult.error.message}`,
                  executionTimeMs: 0,
                }, null, 2),
              }],
              isError: true,
            };
          }
          const input = parseResult.data;

          // Validate security
          this.securityValidator.validateAllowlist(input.allowedTools);
          await this.securityValidator.validatePermissions(input.permissions);

          // Hybrid skip logic:
          // 1. Config/Env variable ONLY (Issue #56 - Security Fix)
          // User input is ignored to prevent security bypass
          const skipPatternCheck = shouldSkipDangerousPatternCheck();
          const codeValidation = this.securityValidator.validateCode(input.code, skipPatternCheck);

          if (!codeValidation.valid) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  output: '',
                  error: codeValidation.errors.join('\n'),
                  executionTimeMs: 0,
                }, null, 2),
              }],
              isError: true,
            };
          }

          // Ensure the downstream MCP pool has finished initializing (it is set
          // up in the background at startup) so callMCPTool/discovery see the
          // connected servers. Bounded by per-server connect timeouts.
          await this.poolReady;

          // Execute code with connection pooling
          const result = await this.connectionPool.execute(async () => {
            return await executeTypescriptInSandbox(
              {
                code: input.code,
                allowedTools: input.allowedTools,
                timeoutMs: input.timeoutMs,
                permissions: input.permissions,
                skipDangerousPatternCheck: skipPatternCheck,
                enableSampling: input.enableSampling,
                maxSamplingRounds: input.maxSamplingRounds,
                maxSamplingTokens: input.maxSamplingTokens,
                samplingSystemPrompt: input.samplingSystemPrompt,
                allowedSamplingModels: input.allowedSamplingModels,
              },
              this.mcpClientPool,
              this.server.server  // Pass underlying Server instance with request() method for MCP sampling
            );
          });

          // Audit log
          await this.securityValidator.auditLog(
            {
              executor: 'typescript',
              allowedTools: input.allowedTools,
              toolsCalled: result.toolCallsMade ?? [],
              executionTimeMs: result.executionTimeMs,
              success: result.success,
              error: result.error,
              clientId: 'default', // MCP servers run locally
              memoryUsage: process.memoryUsage().heapUsed,
            },
            input.code
          );

          return {
            content: [{
              type: 'text' as const,
              text: formatExecutionResultForCli(result),
            }],
            structuredContent: result as MCPExecutionResult,
            isError: !result.success,
          };
        } catch (error) {
          return this.handleToolError(error, ErrorType.EXECUTION);
        }
      };

      this.server.registerTool(
        'executeTypescript',
        typescriptToolConfig,
        typescriptToolHandler
      );
    }

    // Tool 2: Execute Python (optional, enabled via config)
    // SECURITY GATE: Check if Python sandbox is ready
    // Issue #50/#59: Python executor has NO sandbox isolation until Pyodide is implemented
    const PYTHON_SANDBOX_READY = process.env.PYTHON_SANDBOX_READY === 'true';

    if (isPythonEnabled()) {
      if (!PYTHON_SANDBOX_READY) {
        // Register stub handler that returns security warning
        console.error('⚠️  Python executor DISABLED (CRITICAL security vulnerability #50)');
        console.error('   Current Python executor has NO sandbox - full filesystem/network access!');
        console.error('   Set PYTHON_SANDBOX_READY=true only after implementing Pyodide sandbox (issue #59)');

        const pythonSecurityStubConfig: Parameters<McpServer['registerTool']>[1] = {
          title: 'Execute Python with MCP Access (DISABLED - Security Issue)',
          description: `⚠️  CRITICAL SECURITY WARNING ⚠️

Python executor is currently DISABLED due to lack of sandbox isolation.

VULNERABILITY: Issue #50 - Python executor has NO sandbox
- Current implementation runs with full filesystem access
- No network isolation (can access localhost services, cloud metadata)
- Pattern-based security is easily bypassed
- Execution via native subprocess.spawn() with zero restrictions

SOLUTION IN PROGRESS: Issue #59 - Pyodide WebAssembly sandbox
- Same security model as Deno (WASM isolation)
- Virtual filesystem (no host access)
- Network restricted to MCP proxy only
- Industry-proven approach (Pydantic, JupyterLite)

DO NOT enable this tool until Pyodide implementation is complete.
See: https://github.com/aberemia24/code-executor-MCP/issues/50

This tool is DISABLED for your protection.`,
          inputSchema: {
            code: z.string().min(1).describe('Python code (DISABLED)'),
            allowedTools: z.array(z.string()).default([]).describe('MCP tools whitelist (DISABLED)'),
            timeoutMs: z.number().int().min(1000).default(30000).describe('Timeout (DISABLED)'),
          },
          outputSchema: ExecutionResultSchema.shape,
          annotations: {
            readOnlyHint: false,
            destructiveHint: false,
            idempotentHint: false,
            openWorldHint: false,
          },
        };

        const pythonSecurityStubHandler: Parameters<McpServer['registerTool']>[2] = async (args: any, extra: RequestHandlerExtra<any, any>) => {
          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify({
                success: false,
                output: '',
                error: '🔴 CRITICAL: Python executor disabled due to security vulnerability.\n\n' +
                  'ISSUE: No sandbox protection exists in current implementation (issue #50).\n' +
                  '- Full filesystem access (can read /etc/passwd, SSH keys, etc.)\n' +
                  '- Full network access (SSRF to localhost services, cloud metadata endpoints)\n' +
                  '- Pattern-based blocking is easily bypassed\n\n' +
                  'SOLUTION: Pyodide WebAssembly sandbox implementation in progress (issue #59).\n' +
                  '- Same security model as Deno executor\n' +
                  '- Virtual filesystem isolation\n' +
                  '- Network restricted to authenticated MCP proxy\n\n' +
                  'This tool will remain disabled until the security fix is complete.\n' +
                  'For updates: https://github.com/aberemia24/code-executor-MCP/issues/50',
                executionTimeMs: 0,
              }, null, 2),
            }],
            isError: true,
          };
        };

        this.server.registerTool(
          'executePython',
          pythonSecurityStubConfig,
          pythonSecurityStubHandler
        );

        return; // Exit early - don't register real Python handler
      }

      // PYTHON_SANDBOX_READY === true - register real Pyodide handler
      const pythonToolConfig: Parameters<McpServer['registerTool']>[1] = {
        title: 'Execute Python with MCP Access (Pyodide Sandbox)',
        description: `Execute Python code in Pyodide WebAssembly sandbox with access to MCP tools.

Executed code has access to call_mcp_tool(toolName, params) function for calling other MCP servers.

Security (Pyodide Sandbox):
- WebAssembly isolation (same security model as Deno)
- Virtual filesystem (no host file access)
- Network restricted to authenticated MCP proxy only
- Only tools in allowedTools array can be called
- Execution timeout prevents infinite loops
- All executions are audit logged

Args:
  - code (string): Python code to execute
  - allowedTools (string[]): MCP tools whitelist (default: [])
    Format: ['mcp__<server>__<tool>', ...]
    Example: ['mcp__zen__codereview', 'mcp__filesystem__read_file']
  - timeoutMs (number): Execution timeout in milliseconds (default: 30000)
  - permissions (object): Subprocess permissions (limited to temp directory and localhost)
  - skipDangerousPatternCheck (boolean): Skip dangerous pattern validation (optional, default: false)
    Can be overridden by CODE_EXECUTOR_SKIP_DANGEROUS_PATTERNS env var or config file
    NOTE: Dangerous pattern validation is defense-in-depth only, NOT a security boundary
    Real security comes from sandbox permissions, resource limits, and process isolation

Returns:
  {
    "success": boolean,
    "output": string,           // stdout from print()
    "error": string,            // Error message if failed
    "executionTimeMs": number,
    "toolCallsMade": string[],  // MCP tools called
    "toolCallSummary": ToolCallSummaryEntry[] // Aggregated tool call metrics
  }

Example:
  {
    "code": "result = call_mcp_tool('mcp__zen__codereview', {...}); print(result)",
    "allowedTools": ["mcp__zen__codereview"],
    "timeoutMs": 60000
  }`,
        inputSchema: {
          code: z.string().min(1).describe('Python code to execute'),
          allowedTools: z.array(z.string()).default([]).describe('MCP tools whitelist'),
          timeoutMs: z.number().int().min(1000).default(30000).describe('Timeout in milliseconds'),
          permissions: z.object({
            read: z.array(z.string()).optional(),
            write: z.array(z.string()).optional(),
            net: z.array(z.string()).optional(),
          }).default({}).describe('Subprocess permissions'),
          skipDangerousPatternCheck: z.boolean().optional().describe('Skip dangerous pattern validation (defense-in-depth only)'),
          enableSampling: z.boolean().optional().default(false).describe('Enable LLM sampling (llm.ask/llm.think helpers)'),
          maxSamplingRounds: z.number().int().min(1).max(100).optional().default(10).describe('Max sampling rounds'),
          maxSamplingTokens: z.number().int().min(100).max(100000).optional().default(10000).describe('Max sampling tokens'),
          samplingSystemPrompt: z.string().optional().describe('Custom system prompt for sampling'),
          allowedSamplingModels: z.array(z.string()).optional().describe('Allowed Claude models for sampling'),
        },
        outputSchema: ExecutionResultSchema.shape,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: true,
        },
      };

      const pythonToolHandler: Parameters<McpServer['registerTool']>[2] = async (args: any, extra: RequestHandlerExtra<any, any>) => {
        try {
          // Check rate limit
          const rateLimitError = await this.checkRateLimit();
          if (rateLimitError) {
            return rateLimitError;
          }

          // Validate input with Zod schema
          const parseResult = ExecutePythonInputSchema.safeParse(args);
          if (!parseResult.success) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  output: '',
                  error: `Input validation failed: ${parseResult.error.message}`,
                  executionTimeMs: 0,
                }, null, 2),
              }],
              isError: true,
            };
          }
          const input = parseResult.data;

          // Validate security
          this.securityValidator.validateAllowlist(input.allowedTools);
          await this.securityValidator.validatePermissions(input.permissions);

          // Hybrid skip logic:
          // 1. Config/Env variable ONLY (Issue #56 - Security Fix)
          // User input is ignored to prevent security bypass
          const skipPatternCheck = shouldSkipDangerousPatternCheck();
          const codeValidation = this.securityValidator.validateCode(input.code, skipPatternCheck);

          if (!codeValidation.valid) {
            return {
              content: [{
                type: 'text' as const,
                text: JSON.stringify({
                  success: false,
                  output: '',
                  error: codeValidation.errors.join('\n'),
                  executionTimeMs: 0,
                }, null, 2),
              }],
              isError: true,
            };
          }

          // Ensure the downstream MCP pool has finished initializing (background
          // startup) before executing. Bounded by per-server connect timeouts.
          await this.poolReady;

          // Execute code with connection pooling
          // Use Pyodide (secure) when PYTHON_SANDBOX_READY, otherwise native (insecure)
          // Pyodide loaded lazily so its 13MB WASM stays out of compiled binaries that don't enable it.
          let executePythonInSandbox: ExecutePythonPyodideFn;
          if (PYTHON_SANDBOX_READY) {
            const pyodideMod = await import('./executors/pyodide-executor.js');
            executePythonInSandbox = pyodideMod.executePythonInSandbox;
          } else {
            executePythonInSandbox = executePythonNative;
          }

          const result = await this.connectionPool.execute(async () => {
            return await executePythonInSandbox(
              {
                code: input.code,
                allowedTools: input.allowedTools,
                timeoutMs: input.timeoutMs,
                permissions: input.permissions,
                skipDangerousPatternCheck: skipPatternCheck,
                enableSampling: input.enableSampling,
                maxSamplingRounds: input.maxSamplingRounds,
                maxSamplingTokens: input.maxSamplingTokens,
                samplingSystemPrompt: input.samplingSystemPrompt,
                allowedSamplingModels: input.allowedSamplingModels,
              },
              this.mcpClientPool,
              this.server.server  // Pass underlying Server instance with request() method for MCP sampling
            );
          });

          // Audit log
          await this.securityValidator.auditLog(
            {
              executor: 'python',
              allowedTools: input.allowedTools,
              toolsCalled: result.toolCallsMade ?? [],
              executionTimeMs: result.executionTimeMs,
              success: result.success,
              error: result.error,
              clientId: 'default', // MCP servers run locally
              memoryUsage: process.memoryUsage().heapUsed,
            },
            input.code
          );

          return {
            content: [{
              type: 'text' as const,
              text: formatExecutionResultForCli(result),
            }],
            structuredContent: result as MCPExecutionResult,
            isError: !result.success,
          };
        } catch (error) {
          return this.handleToolError(error, ErrorType.EXECUTION);
        }
      };

      this.server.registerTool(
        'executePython',
        pythonToolConfig,
        pythonToolHandler
      );
    }

    // Tool 3: Health Check
    this.server.registerTool(
      'health',
      {
        title: 'Server Health Check',
        description: `Get server health status including audit log, MCP connections, connection pool, and uptime.

Returns:
  {
    "healthy": boolean,
    "auditLog": { "enabled": boolean },
    "mcpClients": { "connected": number },
    "connectionPool": { "active": number, "waiting": number, "max": number },
    "uptime": number
  }`,
        inputSchema: {},
        outputSchema: HealthCheckOutputSchema.shape,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      async (args: any, extra: RequestHandlerExtra<any, any>) => {
        try {
          const tools = this.mcpClientPool.listAllTools();
          const poolStats = this.connectionPool.getStats();

          const health = {
            healthy: true,
            auditLog: {
              enabled: this.securityValidator.isAuditLogEnabled(),
            },
            mcpClients: {
              connected: tools.length,
            },
            connectionPool: poolStats,
            uptime: process.uptime(),
            timestamp: new Date().toISOString(),
          };

          return {
            content: [{
              type: 'text' as const,
              text: JSON.stringify(health, null, 2),
            }],
            structuredContent: health,
          };
        } catch (error) {
          return this.handleToolError(error, ErrorType.EXECUTION);
        }
      }
    );
  }

  /**
   * Start server
   *
   * Errors are propagated to caller for proper error handling.
   */
  async start(): Promise<void> {
    // Initialize configuration
    console.error('Loading configuration...');
    await initConfig();

    // Check Deno availability
    console.error('Checking Deno availability...');
    this.denoAvailable = await checkDenoAvailable();

    if (this.denoAvailable) {
      const version = getDenoVersion();
      console.error(`✓ Deno ${version ?? 'found'} - TypeScript execution enabled`);
    } else {
      console.error(getDenoInstallMessage());
      console.error(''); // Empty line for readability
    }

    // Register tools (now that config is initialized and Deno checked)
    this.registerTools();

    // Initialize rate limiter if enabled
    if (isRateLimitEnabled()) {
      const rateLimitConfig = getRateLimitConfig();
      if (rateLimitConfig) {
        this.rateLimiter = new RateLimiter({
          maxRequests: rateLimitConfig.maxRequests,
          windowMs: rateLimitConfig.windowMs,
        });
        console.error(`Rate limiting enabled: ${rateLimitConfig.maxRequests} requests per ${rateLimitConfig.windowMs / 1000}s`);
      }
    }

    // Start stdio transport FIRST so the upstream MCP handshake (initialize +
    // tools/list) is answered immediately. The downstream client pool is then
    // initialized in the BACKGROUND. This decouples our own readiness from the
    // health of downstream servers: a slow/unreachable server can no longer
    // delay startup past the host's timeout and trigger a respawn loop.
    const transport = new StdioServerTransport();
    await this.server.connect(transport);

    console.error('Code Executor MCP Server started successfully (downstream MCP pool initializing in background)');

    // Initialize MCP client pool in the background. Tool handlers await
    // `poolReady` before executing (see registerTools). Failures are logged but
    // never crash the server — code-executor keeps serving whatever connected.
    console.error('Initializing MCP client pool...');
    this.poolReady = this.mcpClientPool
      .initialize()
      .then(() => {
        const tools = this.mcpClientPool.listAllTools();
        console.error(`Connected to ${tools.length} MCP tools across multiple servers`);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `MCP client pool initialization failed — continuing without downstream tools: ${message}`
        );
      });

    // Initialize health check server (optional, enabled via env var)
    const enableHealthCheck = process.env.ENABLE_HEALTH_CHECK !== 'false';
    if (enableHealthCheck) {
      console.error('Starting health check server...');
      this.healthCheckServer = new HealthCheckServer({
        mcpClientPool: this.mcpClientPool,
        connectionPool: this.connectionPool,
        version: VERSION,
      });

      try {
        await this.healthCheckServer.start();
      } catch (error) {
        console.error('Warning: Failed to start health check server:', error);
        // Don't fail the entire server if health check fails to start
        this.healthCheckServer = null;
      }
    }
  }

  /**
   * Synchronously kill all spawned downstream child processes.
   * Backstop for the process 'exit' handler (see bottom of file).
   */
  killChildrenSync(): void {
    this.mcpClientPool.killChildrenSync();
  }

  /**
   * Shutdown server
   */
  /**
   * Graceful shutdown with request draining
   *
   * P1: Wait for in-flight executions to complete before shutdown.
   * Fixes race condition where active TypeScript/Python executions are killed mid-operation.
   *
   * Shutdown sequence:
   * 1. Drain connection pool (wait for active executions with 30s timeout)
   * 2. Stop health check server
   * 3. Clean up rate limiter
   * 4. Disconnect MCP clients (with 2s SIGTERM grace period)
   *
   * @param timeoutMs - Maximum time for entire shutdown (default: 35s = 30s drain + 5s cleanup)
   */
  async shutdown(timeoutMs: number = 35000): Promise<void> {
    // P1: Prevent concurrent shutdown attempts (manual + signal handler races)
    if (this.shutdownInProgress) {
      console.error('Shutdown already in progress - ignoring duplicate call');
      return;
    }
    this.shutdownInProgress = true;

    const shutdownStart = Date.now();

    // Wrap entire shutdown in timeout protection
    const shutdownPromise = (async () => {
      // Phase 1: Drain connection pool (wait for active executions)
      console.error('Phase 1: Draining connection pool...');
      try {
        await this.connectionPool.drain(30000); // 30s timeout for executions
      } catch (error) {
        console.error('Error draining connection pool:', error);
      }

      // Phase 2: Stop health check server
      console.error('Phase 2: Stopping health check server...');
      if (this.healthCheckServer) {
        try {
          await this.healthCheckServer.stop();
        } catch (error) {
          console.error('Error stopping health check server:', error);
        }
      }

      // Phase 3: Clean up rate limiter
      console.error('Phase 3: Cleaning up rate limiter...');
      if (this.rateLimiter) {
        this.rateLimiter.destroy();
      }

      // Phase 4: Disconnect MCP clients (with 2s SIGTERM grace period)
      console.error('Phase 4: Disconnecting MCP clients...');
      await this.mcpClientPool.disconnect();

      const elapsed = Date.now() - shutdownStart;
      console.error(`✓ Graceful shutdown completed in ${elapsed}ms`);
    })();

    // Race against timeout
    const timeoutPromise = new Promise<void>((resolve) => {
      setTimeout(() => {
        const elapsed = Date.now() - shutdownStart;
        console.error(
          `⚠️ Shutdown timeout after ${timeoutMs}ms (elapsed: ${elapsed}ms) - forcing exit`
        );
        resolve();
      }, timeoutMs);
    });

    await Promise.race([shutdownPromise, timeoutPromise]);

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
  // Normal server startup flow
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
