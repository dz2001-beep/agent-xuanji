/**
 * Minimal .env loader (no dependency).
 *
 * Reads KEY=VALUE pairs from <cwd>/.env into process.env. Existing
 * non-empty environment variables win (so a shell export takes priority);
 * empty-string values are treated as unset and get overridden.
 *
 * Only quoted values are de-quoted; no interpolation, no comments in values.
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export function loadDotEnv(file = '.env', cwd = process.cwd()): void {
  const abs = path.resolve(cwd, file);
  if (!existsSync(abs)) return;
  const text = readFileSync(abs, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    const current = process.env[key];
    if (current === undefined || current.trim() === '') {
      process.env[key] = value;
    }
  }
}
