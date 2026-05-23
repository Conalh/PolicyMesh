import { configPath, isRecord, readJsonObjectWithSource } from './discovery.js';
import { signFinding } from './exceptions.js';
const BASELINE_FILE = '.policymesh-baseline.json';
const RATING_RANK = {
    none: 0,
    low: 1,
    medium: 2,
    high: 3,
    critical: 4
};
export async function loadBaseline(root) {
    const source = await readJsonObjectWithSource(configPath(root, BASELINE_FILE));
    if (!source.text.trim()) {
        return {};
    }
    if (source.parseError) {
        return {
            parseFinding: signFinding({
                kind: 'policy_mesh.baseline_parse_error',
                severity: 'medium',
                file: BASELINE_FILE,
                line: source.parseError.line,
                subject: BASELINE_FILE,
                message: `Could not parse baseline at ${BASELINE_FILE}: ${source.parseError.message}.`,
                recommendation: 'Fix the JSON syntax so PolicyMesh can compare findings against the baseline.',
                surfaces: []
            })
        };
    }
    const expectedRating = isMeshRating(source.json.expectedRating)
        ? source.json.expectedRating
        : undefined;
    const pinnedMcpServers = readStringMap(source.json.pinnedMcpServers);
    if (!expectedRating && !pinnedMcpServers) {
        return {};
    }
    return {
        baseline: {
            expectedRating,
            pinnedMcpServers
        }
    };
}
/**
 * Produce drift findings — entries that say "the repo is failing to
 * uphold something the team explicitly declared as the intended
 * state." These are HIGH severity by default because the baseline is
 * the team's contract, not a target.
 */
export function evaluateBaseline(baseline, policies, rating) {
    const findings = [];
    if (baseline.expectedRating && RATING_RANK[rating] > RATING_RANK[baseline.expectedRating]) {
        findings.push(signFinding({
            kind: 'policy_mesh.baseline_rating_drift',
            severity: 'high',
            file: '.policymesh-baseline.json',
            subject: 'expectedRating',
            message: `Repo rating "${rating}" exceeds baseline expectedRating "${baseline.expectedRating}". The baseline encodes the team's intended posture and this PR drifts above it.`,
            recommendation: `Either resolve findings until the rating returns to "${baseline.expectedRating}", or update the baseline to acknowledge the new floor.`,
            surfaces: []
        }));
    }
    if (baseline.pinnedMcpServers) {
        for (const [name, expectedVersion] of Object.entries(baseline.pinnedMcpServers)) {
            for (const surface of policies.mcpSurfaces) {
                for (const server of surface.servers) {
                    if (server.name !== name) {
                        continue;
                    }
                    const actualVersion = extractPinnedVersion(server.command);
                    if (actualVersion === expectedVersion) {
                        continue;
                    }
                    findings.push(signFinding({
                        kind: 'policy_mesh.baseline_version_drift',
                        severity: 'high',
                        file: server.file,
                        line: server.line,
                        subject: name,
                        message: actualVersion
                            ? `MCP server "${name}" is pinned to "${actualVersion}" in ${surface.surfaceId} but the baseline expects "${expectedVersion}".`
                            : `MCP server "${name}" in ${surface.surfaceId} is not pinned to a recognisable version; the baseline expects "${expectedVersion}".`,
                        recommendation: 'Repin the server to the baseline version, or update the baseline if the new version is intentional and reviewed.',
                        surfaces: [server.surfaceId]
                    }));
                }
            }
        }
    }
    return findings;
}
function isMeshRating(value) {
    return value === 'none' || value === 'low' || value === 'medium' || value === 'high' || value === 'critical';
}
function readStringMap(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const entries = [];
    for (const [key, val] of Object.entries(value)) {
        if (typeof val === 'string') {
            entries.push([key, val]);
        }
    }
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
function extractPinnedVersion(command) {
    const match = /@(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)/.exec(command);
    return match?.[1];
}
