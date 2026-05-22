import { parseClaudePolicy } from './claude.js';
import { parseCodexPolicy } from './codex.js';
import { parseMcpSurfaces } from './mcp.js';
import { parseAiderPolicy } from './aider.js';
import type { RepoPolicies } from '../types.js';

export async function parseRepoPolicies(root: string): Promise<RepoPolicies> {
  const [mcp, claude, codex, aider] = await Promise.all([
    parseMcpSurfaces(root),
    parseClaudePolicy(root),
    parseCodexPolicy(root),
    parseAiderPolicy(root)
  ]);

  return {
    mcpSurfaces: codex.mcpSurface ? [...mcp.surfaces, codex.mcpSurface] : mcp.surfaces,
    claude: claude.policy,
    codex: codex.policy,
    aider: aider.policy,
    parseFindings: [...mcp.findings, ...claude.findings, ...codex.findings, ...aider.findings]
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
  if (policies.aider) {
    surfaces.add('aider');
  }
  for (const finding of policies.parseFindings ?? []) {
    for (const surface of finding.surfaces) {
      surfaces.add(surface);
    }
  }
  return surfaces.size;
}
