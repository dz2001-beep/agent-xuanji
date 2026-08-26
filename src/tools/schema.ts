/**
 * Lightweight argument validation against a JSON Schema (draft-07 subset).
 *
 * We deliberately do NOT pull in a full JSON-Schema validator: models are
 * usually well-behaved, and a small checker covers the failure modes that
 * matter (wrong shape, missing required fields, wrong primitive types).
 */

import type { JsonSchema } from './tool.js';

export interface ValidationIssue {
  path: string;
  message: string;
}

function typeCheck(schema: JsonSchema, value: unknown): boolean {
  const t = schema.type;
  if (!t) return true;
  switch (t) {
    case 'string':
      return typeof value === 'string';
    case 'number':
    case 'integer':
      return typeof value === 'number' && (t !== 'integer' || Number.isInteger(value));
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

/** Validate `args` against `schema`. Returns a list of issues (empty = valid). */
export function validateArgs(schema: JsonSchema, args: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    return [{ path: '$', message: 'arguments must be a JSON object' }];
  }
  const obj = args as Record<string, unknown>;

  for (const key of schema.required ?? []) {
    if (!(key in obj) || obj[key] === undefined) {
      issues.push({ path: key, message: `missing required property "${key}"` });
    }
  }

  for (const [key, value] of Object.entries(obj)) {
    const sub = schema.properties?.[key];
    if (!sub) continue; // extra properties are tolerated (models drift)
    const path = key;
    if (!typeCheck(sub, value)) {
      issues.push({ path, message: `expected ${sub.type}, got ${Array.isArray(value) ? 'array' : typeof value}` });
    }
    if (sub.type === 'array' && sub.items && Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (!typeCheck(sub.items, value[i])) {
          issues.push({ path: `${path}[${i}]`, message: `expected ${sub.items.type}, got ${typeof value[i]}` });
        }
      }
    }
  }

  return issues;
}

export function formatIssues(issues: ValidationIssue[]): string {
  return issues.map((i) => `${i.path}: ${i.message}`).join('; ');
}
