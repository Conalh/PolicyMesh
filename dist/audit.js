import { countConfiguredSurfaces, parseRepoPolicies } from './parsers/index.js';
import { buildEffectiveUnion, buildSurfaceMatrix, runMeshRules } from './mesh/engine.js';
import { detectMissingLocalScripts } from './mesh/local-scripts.js';
import { applyExceptions, loadExceptions, signFinding } from './exceptions.js';
import { evaluateBaseline, loadBaseline } from './baseline.js';
const severityRank = {
    none: 0,
    low: 1,
    medium: 2,
    high: 3,
    critical: 4
};
export async function auditRepo(root) {
    const policies = await parseRepoPolicies(root);
    const [{ exceptions, parseFinding: exceptionsParseFinding }, missingScriptFindings, { baseline, parseFinding: baselineParseFinding }] = await Promise.all([
        loadExceptions(root),
        detectMissingLocalScripts(policies, root),
        loadBaseline(root)
    ]);
    const rawFindings = [
        ...(policies.parseFindings ?? []),
        ...runMeshRules(policies),
        ...missingScriptFindings
    ].map(signFinding);
    const filteredFindings = applyExceptions(rawFindings, exceptions);
    // Compute the rating BEFORE baseline drift checks so drift comparisons
    // operate against the post-exception state, matching what reviewers see.
    const ratingBeforeBaseline = rateFindings(filteredFindings);
    const baselineDriftFindings = baseline
        ? evaluateBaseline(baseline, policies, ratingBeforeBaseline)
        : [];
    const findings = [
        ...filteredFindings,
        ...baselineDriftFindings,
        ...(exceptionsParseFinding ? [signFinding(exceptionsParseFinding)] : []),
        ...(baselineParseFinding ? [baselineParseFinding] : [])
    ];
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
