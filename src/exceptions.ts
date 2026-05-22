import { configPath, isRecord, readJsonObjectWithSource } from './discovery.js';
import type { Exception, Finding, Severity } from './types.js';

const EXCEPTIONS_FILE = '.policymesh-exceptions.json';

export interface ExceptionsResult {
  exceptions: Exception[];
  parseFinding?: Finding;
}

export async function loadExceptions(root: string): Promise<ExceptionsResult> {
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

  const exceptions: Exception[] = [];
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
      expiry: typeof entry.expiry === 'string' ? entry.expiry : undefined
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
export function applyExceptions(findings: Finding[], exceptions: Exception[], now: Date = new Date()): Finding[] {
  if (exceptions.length === 0) {
    return findings;
  }

  const result: Finding[] = [];
  for (const finding of findings) {
    const match = exceptions.find(
      (exception) => exception.kind === finding.kind && exception.subject === finding.subject
    );
    if (!match) {
      result.push(finding);
      continue;
    }

    if (match.expiry && isExpired(match.expiry, now)) {
      result.push(downgradeExpired(finding));
      continue;
    }

    // Active exception — suppress.
  }
  return result;
}

function isExpired(expiry: string, now: Date): boolean {
  const parsed = new Date(expiry);
  if (Number.isNaN(parsed.getTime())) {
    return false;
  }
  return parsed.getTime() < now.getTime();
}

function downgradeExpired(finding: Finding): Finding {
  const downgraded: Severity = 'low';
  return {
    ...finding,
    severity: downgraded,
    message: `[EXPIRED WHITELIST] ${finding.message}`
  };
}
