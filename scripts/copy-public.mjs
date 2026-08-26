/**
 * Copy the web UI static assets (public/) into the compiled output.
 * tsc only emits TS files, so this runs after every build.
 */

import { cpSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = path.join(root, 'src', 'server', 'public');
const dest = path.join(root, 'dist', 'src', 'server', 'public');

if (!existsSync(src)) {
  console.error(`[copy-public] source not found: ${src}`);
  process.exit(1);
}
mkdirSync(path.dirname(dest), { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`[copy-public] ${src} → ${dest}`);
