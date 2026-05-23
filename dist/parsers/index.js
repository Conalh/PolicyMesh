import { parseClaudePolicy } from './claude.js';
import { parseCodexPolicy } from './codex.js';
import { parseMcpSurfaces } from './mcp.js';
import { parseAiderPolicy } from './aider.js';
import { parseInstructionsPolicy } from './instructions.js';
export async function parseRepoPolicies(root) {
    const [mcp, claude, codex, aider, instructions] = await Promise.all([
        parseMcpSurfaces(root),
        parseClaudePolicy(root),
        parseCodexPolicy(root),
        parseAiderPolicy(root),
        parseInstructionsPolicy(root)
    ]);
    return {
        mcpSurfaces: codex.mcpSurface ? [...mcp.surfaces, codex.mcpSurface] : mcp.surfaces,
        claude: claude.policy,
        codex: codex.policy,
        aider: aider.policy,
        instructions: instructions.policy,
        parseFindings: [
            ...mcp.findings,
            ...claude.findings,
            ...codex.findings,
            ...aider.findings,
            ...instructions.findings
        ]
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
    if (policies.aider) {
        surfaces.add('aider');
    }
    if (policies.instructions) {
        surfaces.add('instructions');
    }
    for (const finding of policies.parseFindings ?? []) {
        for (const surface of finding.surfaces) {
            surfaces.add(surface);
        }
    }
    return surfaces.size;
}
