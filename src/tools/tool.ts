/**
 * The Tool abstraction — the single interface every capability plugs into:
 * built-in tools, MCP tools, user-supplied tools.
 */

/** Minimal JSON Schema (draft-07 subset) accepted for tool input descriptions. */
export interface JsonSchema {
  type?: string;
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}

export interface ToolContext {
  /** Unique id of this invocation (echoes the model's tool call id). */
  callId: string;
  /** Optional session scope, propagated by the caller. */
  sessionId?: string;
  /** Abort signal wired to the caller's cancellation. */
  signal?: AbortSignal;
  /**
   * Session working directory. Tools that accept relative paths resolve
   * them against this (the chat client sets it to the user's chosen dir).
   */
  cwd?: string;
}

export type ToolResult = { ok: true; data: unknown } | { ok: false; error: string };

/** Tools throw ToolError to signal a *recoverable* failure to the model. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  execute(input: unknown, ctx: ToolContext): Promise<ToolResult>;
}

export function toolResult(data: unknown): ToolResult {
  return { ok: true, data };
}

export function toolError(error: string): ToolResult {
  return { ok: false, error };
}

/** Central place to register/query the tools exposed to the model. */
export class ToolRegistry {
  private tools = new Map<string, Tool>();

  /** Register a tool. Throws on name collision (fail fast, avoid ambiguity). */
  register(tool: Tool): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Tool name collision: "${tool.name}" is already registered`);
    }
    this.tools.set(tool.name, tool);
  }

  /** Register tools that tolerate collisions (later ones win) — used by MCP refresh. */
  registerMany(tools: Tool[], { overwrite = false }: { overwrite?: boolean } = {}): void {
    for (const tool of tools) {
      if (overwrite) this.tools.set(tool.name, tool);
      else this.register(tool);
    }
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  remove(name: string): boolean {
    return this.tools.delete(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  names(): string[] {
    return [...this.tools.keys()];
  }
}
