import { parseClaudePolicy } from './claude.js';
import { parseCodexPolicy } from './codex.js';
import { parseMcpSurfaces } from './mcp.js';
import type { RepoPolicies } from '../types.js';

export async function parseRepoPolicies(root: string): Promise<RepoPolicies> {
  const [mcp, claude, codex] = await Promise.all([
    parseMcpSurfaces(root),
    parseClaudePolicy(root),
    parseCodexPolicy(root)
  ]);

  return {
    mcpSurfaces: mcp.surfaces,
    claude: claude.policy,
    codex,
    parseFindings: [...mcp.findings, ...claude.findings]
  };
}

export function countConfiguredSurfaces(policies: RepoPolicies): number {
  const surfaces = new Set(policies.mcpSurfaces.map((surface) => surface.surfaceId));
  if (policies.claude) {
    surfaces.add('claude');
  }
  if (policies.codex) {
    surfaces.add('codex');
  }
  for (const finding of policies.parseFindings ?? []) {
    for (const surface of finding.surfaces) {
      surfaces.add(surface);
    }
  }
  return surfaces.size;
}
