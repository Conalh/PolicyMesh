import { parseClaudePolicy } from './claude.js';
import { parseCodexPolicy } from './codex.js';
import { parseMcpSurfaces } from './mcp.js';
import type { RepoPolicies } from '../types.js';

export async function parseRepoPolicies(root: string): Promise<RepoPolicies> {
  const [mcpSurfaces, claude, codex] = await Promise.all([
    parseMcpSurfaces(root),
    parseClaudePolicy(root),
    parseCodexPolicy(root)
  ]);

  return { mcpSurfaces, claude, codex };
}

export function countConfiguredSurfaces(policies: RepoPolicies): number {
  let count = policies.mcpSurfaces.length;
  if (policies.claude) {
    count += 1;
  }
  if (policies.codex) {
    count += 1;
  }
  return count;
}
