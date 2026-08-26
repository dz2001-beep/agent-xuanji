/**
 * MCP (Model Context Protocol) server configuration.
 *
 * The registry supports the two transports that matter in practice:
 *  - stdio: spawn a local server subprocess (the common local-server case);
 *  - streamable-http: talk to a remote MCP server over HTTP.
 */

export type McpTransportKind = 'stdio' | 'streamable-http';

export interface McpServerConfig {
  /** Unique id — used to namespace the server's tools (e.g. id "weather" → tool "weather.current"). */
  id: string;
  transport: McpTransportKind;
  /** stdio: command to spawn. */
  command?: string;
  /** stdio: arguments for the command. */
  args?: string[];
  /** stdio: extra environment variables (merged over process.env). */
  env?: Record<string, string>;
  /** stdio: working directory for the child process. */
  cwd?: string;
  /** streamable-http: server URL. */
  url?: string;
  /** streamable-http: extra headers (e.g. Authorization). */
  headers?: Record<string, string>;
  /** Connect lazily on first use instead of at harness startup. */
  lazy?: boolean;
}

export function validateMcpConfig(cfg: McpServerConfig): void {
  if (!cfg.id || !/^[a-zA-Z0-9_-]+$/.test(cfg.id)) {
    throw new Error(`MCP server id must be a non-empty identifier, got ${JSON.stringify(cfg.id)}`);
  }
  if (cfg.transport === 'stdio') {
    if (!cfg.command) throw new Error(`MCP server "${cfg.id}": stdio transport requires "command"`);
  } else if (cfg.transport === 'streamable-http') {
    if (!cfg.url) throw new Error(`MCP server "${cfg.id}": streamable-http transport requires "url"`);
  } else {
    throw new Error(`MCP server "${cfg.id}": unknown transport ${JSON.stringify(cfg.transport)}`);
  }
}
