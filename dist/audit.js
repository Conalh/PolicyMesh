import { countConfiguredSurfaces, parseRepoPolicies } from './parsers/index.js';
import { buildEffectiveUnion, buildSurfaceMatrix, runMeshRules } from './mesh/engine.js';
const severityRank = {
    none: 0,
    low: 1,
    medium: 2,
    high: 3,
    critical: 4
};
export async function auditRepo(root) {
    const policies = await parseRepoPolicies(root);
    const findings = [...(policies.parseFindings ?? []), ...runMeshRules(policies)];
    return {
        rating: rateFindings(findings),
        findingCount: findings.length,
        surfaceCount: countConfiguredSurfaces(policies),
        findings,
        effectiveUnion: buildEffectiveUnion(policies),
        matrix: buildSurfaceMatrix(policies)
    };
}
function rateFindings(findings) {
    let rating = 'none';
    for (const finding of findings) {
        if (severityRank[finding.severity] > severityRank[rating]) {
            rating = finding.severity;
        }
    }
    return rating;
}
export function meetsFailThreshold(rating, failOn) {
    if (failOn === 'none') {
        return false;
    }
    return severityRank[rating] >= severityRank[failOn];
}
export { severityRank };
