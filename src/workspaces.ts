/**
 * Workspace management — multiple isolated workspaces.
 *
 * Each workspace owns a directory (the base for fs/shell tools) and its own
 * conversation history, so different tasks run in different workspaces
 * without interference. Workspace metadata (id/name/path) is persisted to
 * <XUANJI_HOME | ~>/.xuanji/workspaces.json; histories stay in memory.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface WorkspaceMeta {
  id: string;
  name: string;
  path: string;
}

export function createWorkspaceId(): string {
  return `ws_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function workspacesFile(): string {
  return path.join(process.env.XUANJI_HOME ?? os.homedir(), '.xuanji', 'workspaces.json');
}

/** Load saved workspaces; returns [] when none exist. */
export async function loadWorkspaces(): Promise<WorkspaceMeta[]> {
  try {
    const raw = await fs.readFile(workspacesFile(), 'utf8');
    const parsed = JSON.parse(raw) as { workspaces?: WorkspaceMeta[] };
    return Array.isArray(parsed.workspaces) ? parsed.workspaces : [];
  } catch {
    return [];
  }
}

export async function saveWorkspaces(workspaces: WorkspaceMeta[]): Promise<void> {
  const file = workspacesFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ workspaces }, null, 2), 'utf8');
}
