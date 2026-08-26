/**
 * McpRegistry — manages connections to one or more MCP servers and adapts
 * their tools into harness `Tool`s.
 *
 * Design notes:
 *  - Tool names are NAMESPACED as `<serverId>.<toolName>` so that several
 *    servers exposing the same tool name (a common collision: two servers
 *    both offer `search`) coexist without ambiguity, mirroring how Claude
 *    Desktop surfaces server tools.
 *  - Tool lists are fetched once per connection and cached; `refresh()`
 *    re-lists on demand (servers may add tools while running).
 *  - Protocol results are mapped onto the harness `ToolResult` shape so the
 *    Agent Loop treats MCP tools exactly like built-ins.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import { validateMcpConfig, type McpServerConfig } from './config.js';
import type { Tool, ToolResult, JsonSchema } from '../tools/tool.js';
import { toolError, toolResult } from '../tools/tool.js';
import { stringify } from '../utils.js';

const VERSION = '0.1.0';

export interface McpHandle {
  readonly id: string;
  readonly serverInfo: string;
  /** Currently cached tool list (refresh via listTools()). */
  tools: McpTool[];
  listTools(): Promise<McpTool[]>;
  callTool(name: string, args: unknown): Promise<ToolResult>;
  close(): Promise<void>;
}

function buildTransport(cfg: McpServerConfig): Transport {
  if (cfg.transport === 'stdio') {
    return new StdioClientTransport({
      command: cfg.command!,
      args: cfg.args,
      env: { ...process.env, ...(cfg.env ?? {}) } as Record<string, string>,
      cwd: cfg.cwd,
      stderr: 'pipe',
    });
  }
  return new StreamableHTTPClientTransport(new URL(cfg.url!), {
    requestInit: { headers: cfg.headers },
  });
}

async function callMcp(
  client: Client,
  name: string,
  args: unknown,
): Promise<ToolResult> {
  const res = await client.callTool({ name, arguments: (args ?? {}) as Record<string, unknown> });
  const content = (res.content ?? []) as Array<{ type: string; text?: string; mimeType?: string; data?: string }>;
  if (res.isError) {
    const text = describeContent(content);
    return toolError(text || `MCP tool "${name}" returned an error (no message)`);
  }
  if (res.structuredContent !== undefined) {
    return toolResult(res.structuredContent);
  }
  return toolResult(describeContent(content));
}

function describeContent(content: Array<{ type: string; text?: string; mimeType?: string; data?: string }>): string {
  const parts: string[] = [];
  for (const item of content ?? []) {
    if (item.type === 'text' && item.text) parts.push(item.text);
    else if (item.type === 'image') parts.push(`[image ${item.mimeType ?? 'unknown'}]`);
    else if (item.type === 'resource') parts.push(stringify(item, 2000));
    else parts.push(`[${item.type} content]`);
  }
  return parts.join('\n');
}

class McpHandleImpl implements McpHandle {
  tools: McpTool[] = [];
  constructor(
    readonly id: string,
    readonly serverInfo: string,
    private readonly client: Client,
  ) {}

  async listTools(): Promise<McpTool[]> {
    const res = await this.client.listTools();
    this.tools = res.tools;
    return this.tools;
  }

  async callTool(name: string, args: unknown): Promise<ToolResult> {
    return callMcp(this.client, name, args);
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}

export class McpRegistry {
  private readonly handles = new Map<string, McpHandleImpl>();

  /** Connect to a configured server and cache its tool list. */
  async connect(cfg: McpServerConfig): Promise<McpHandle> {
    validateMcpConfig(cfg);
    if (this.handles.has(cfg.id)) return this.handles.get(cfg.id)!;

    const client = new Client({ name: 'harness-kit', version: VERSION });
    const transport = buildTransport(cfg);
    await client.connect(transport);

    const version = await client.getServerVersion();
    const handle = new McpHandleImpl(cfg.id, version ? `${version.name}@${version.version}` : 'unknown', client);
    await handle.listTools();
    this.handles.set(cfg.id, handle);
    return handle;
  }

  /**
   * Attach a client to an already-created transport (in-memory links in
   * tests, custom transports, …). Transport ownership is the caller's.
   */
  async attach(id: string, transport: Transport, clientName = 'harness-kit'): Promise<McpHandle> {
    if (this.handles.has(id)) throw new Error(`MCP server "${id}" is already connected`);
    const client = new Client({ name: clientName, version: VERSION });
    await client.connect(transport);
    const version = await client.getServerVersion();
    const handle = new McpHandleImpl(id, version ? `${version.name}@${version.version}` : 'unknown', client);
    await handle.listTools();
    this.handles.set(id, handle);
    return handle;
  }

  get(id: string): McpHandle | undefined {
    return this.handles.get(id);
  }

  handlesList(): McpHandle[] {
    return [...this.handles.values()];
  }

  /** Re-fetch tool lists from every connected server. */
  async refresh(): Promise<void> {
    for (const handle of this.handles.values()) {
      await handle.listTools();
    }
  }

  /** All tools across all servers, as harness Tools (namespaced names). */
  toTools(): Tool[] {
    const tools: Tool[] = [];
    for (const handle of this.handles.values()) {
      for (const mcpTool of handle.tools) {
        tools.push(mcpToolToHarnessTool(handle, mcpTool));
      }
    }
    return tools;
  }

  /** Call a tool by its namespaced name `<serverId>.<toolName>`. */
  async callTool(namespacedName: string, args: unknown): Promise<ToolResult> {
    const dot = namespacedName.indexOf('.');
    if (dot < 1) return toolError(`invalid namespaced tool name "${namespacedName}"`);
    const serverId = namespacedName.slice(0, dot);
    const toolName = namespacedName.slice(dot + 1);
    const handle = this.handles.get(serverId);
    if (!handle) return toolError(`no connected MCP server "${serverId}"`);
    try {
      return await handle.callTool(toolName, args);
    } catch (err) {
      return toolError(`MCP call failed (server "${serverId}", tool "${toolName}"): ${(err as Error).message}`);
    }
  }

  async disconnectAll(): Promise<void> {
    await Promise.allSettled([...this.handles.values()].map((h) => h.close()));
    this.handles.clear();
  }
}

/** Adapt one MCP tool into a harness Tool, namespaced by server id. */
export function mcpToolToHarnessTool(handle: McpHandle, mcpTool: McpTool): Tool {
  return {
    name: `${handle.id}.${mcpTool.name}`,
    description: mcpTool.description ?? `(tool from MCP server "${handle.id}")`,
    inputSchema: mcpTool.inputSchema as unknown as JsonSchema,
    execute: async (args) => handle.callTool(mcpTool.name, args),
  };
}
