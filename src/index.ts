/**
 * xuanji — a lightweight, extensible agent harness.
 *
 * Public API surface:
 *  - Agent Loop:      Agent, AgentResult, AgentEvent, RunOptions
 *  - Tools:           Tool, ToolRegistry, ToolError, built-ins
 *  - MCP:             McpRegistry, McpHandle, McpServerConfig
 *  - Skills:          SkillRegistry, Skill, renderSkills
 *  - Composition:     Harness, HarnessConfig, loadConfigFile
 *  - Providers:       ChatProvider, OpenAICompatibleProvider, MockProvider
 */

// Types
export * from './types.js';
export * from './utils.js';

// LLM providers
export * from './llm/provider.js';
export * from './llm/openai.js';
export * from './llm/mock.js';

// Tools
export * from './tools/tool.js';
export * from './tools/schema.js';
export * from './tools/builtin.js';

// Agent Loop
export * from './loop/agent.js';
export * from './loop/events.js';

// MCP
export * from './mcp/config.js';
export * from './mcp/registry.js';

// Skills
export * from './skills/skill.js';
export * from './skills/frontmatter.js';
export * from './skills/loader.js';
export * from './skills/match.js';
export * from './skills/registry.js';

// Harness composition
export * from './harness/config.js';
export * from './harness/harness.js';
export * from './harness/system.js';
