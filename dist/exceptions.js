import { createHash } from 'node:crypto';
import { configPath, isRecord, readJsonObjectWithSource } from './discovery.js';
/**
 * Stable hash over the subject + file + normalized message of a finding.
 * Used to lock exception baselines to the specific violation reviewers
 * approved, so a later commit that mutates the violation re-fires the
 * finding instead of riding the existing exception.
 *
 * Truncated to 16 hex chars (64 bits) — plenty of collision resistance
 * for the per-repo audit domain, short enough to type and review.
 */
export function computeFindingSignature(finding) {
    const normalizedMessage = finding.message
        .toLowerCase()
        .replace(/\s+/g, ' ')
        .trim();
    const material = `${finding.subject}\n${finding.file}\n${normalizedMessage}`;
    return createHash('sha256').update(material).digest('hex').slice(0, 16);
}
export function signFinding(finding) {
    return { ...finding, signature: computeFindingSignature(finding) };
}
const EXCEPTIONS_FILE = '.policymesh-exceptions.json';
export async function loadExceptions(root) {
    const source = await readJsonObjectWithSource(configPath(root, EXCEPTIONS_FILE));
    if (!source.text.trim()) {
        return { exceptions: [] };
    }
    if (source.parseError) {
        return {
            exceptions: [],
            parseFinding: {
                kind: 'policy_mesh.exceptions_parse_error',
                severity: 'medium',
                file: EXCEPTIONS_FILE,
                line: source.parseError.line,
                subject: EXCEPTIONS_FILE,
                message: `Could not parse exceptions baseline at ${EXCEPTIONS_FILE}: ${source.parseError.message}.`,
                recommendation: 'Fix the JSON syntax so PolicyMesh can apply the exceptions baseline.',
                surfaces: []
            }
        };
    }
    const list = source.json.exceptions;
    if (!Array.isArray(list)) {
        return { exceptions: [] };
    }
    const exceptions = [];
    for (const entry of list) {
        if (!isRecord(entry)) {
            continue;
        }
        if (typeof entry.kind !== 'string' || typeof entry.subject !== 'string') {
            continue;
        }
        exceptions.push({
            kind: entry.kind,
            subject: entry.subject,
            reason: typeof entry.reason === 'string' ? entry.reason : undefined,
            expiry: typeof entry.expiry === 'string' ? entry.expiry : undefined,
            signature: typeof entry.signature === 'string' ? entry.signature : undefined
        });
    }
    return { exceptions };
}
/**
 * Suppress findings matched by an active exception. For expired
 * exceptions, surface the original finding back with severity downgraded
 * to "low" and an "[EXPIRED WHITELIST]" prefix on the message so teams
 * notice their baseline is stale.
 */
export function applyExceptions(findings, exceptions, now = new Date()) {
    if (exceptions.length === 0) {
        return findings;
    }
    const result = [];
    for (const finding of findings) {
        const match = exceptions.find((exception) => exception.kind === finding.kind && exception.subject === finding.subject);
        if (!match) {
            result.push(finding);
            continue;
        }
        // Fingerprint mismatch invalidates the exception — the underlying
        // violation has changed since the reviewer approved it, so we must
        // surface the finding for re-review rather than silently riding the
        // stale exception.
        if (match.signature) {
            const currentSignature = finding.signature ?? computeFindingSignature(finding);
            if (currentSignature !== match.signature) {
                result.push({
                    ...finding,
                    message: `[SIGNATURE MISMATCH] ${finding.message} (exception signature ${match.signature.slice(0, 8)}... no longer matches finding signature ${currentSignature.slice(0, 8)}...; re-review and update the baseline)`
                });
                continue;
            }
        }
        if (match.expiry && isExpired(match.expiry, now)) {
            result.push(downgradeExpired(finding));
            continue;
        }
        // Active exception — suppress.
    }
    return result;
}
function isExpired(expiry, now) {
    const parsed = new Date(expiry);
    if (Number.isNaN(parsed.getTime())) {
        return false;
    }
    return parsed.getTime() < now.getTime();
}
function downgradeExpired(finding) {
    const downgraded = 'low';
    return {
        ...finding,
        severity: downgraded,
        message: `[EXPIRED WHITELIST] ${finding.message}`
    };
}
