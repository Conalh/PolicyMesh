import { parseClaudePolicy } from './claude.js';
import { parseCodexPolicy } from './codex.js';
import { parseMcpSurfaces } from './mcp.js';
export async function parseRepoPolicies(root) {
    const [mcp, claude, codex] = await Promise.all([
        parseMcpSurfaces(root),
        parseClaudePolicy(root),
        parseCodexPolicy(root)
    ]);
    return {
        mcpSurfaces: codex.mcpSurface ? [...mcp.surfaces, codex.mcpSurface] : mcp.surfaces,
        claude: claude.policy,
        codex: codex.policy,
        parseFindings: [...mcp.findings, ...claude.findings, ...codex.findings]
    };
}
export function countConfiguredSurfaces(policies) {
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
