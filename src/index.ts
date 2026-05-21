#!/usr/bin/env node

import { fileURLToPath } from 'node:url';
import { auditRepo } from './audit.js';
import { renderReport } from './report.js';
import type { ReportFormat } from './types.js';

export { auditRepo } from './audit.js';
export type { MeshReport } from './types.js';

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write('Usage: policymesh audit --repo <path> [--format text|markdown|json|github]\n');
    return 0;
  }

  if (argv[0] === 'audit') {
    return runAudit(argv.slice(1));
  }

  process.stderr.write(`Unknown command: ${argv[0]}\n`);
  return 2;
}

async function runAudit(argv: string[]): Promise<number> {
  const parsed = parseAuditArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n${usage()}\n`);
    return 2;
  }

  const report = await auditRepo(parsed.repo);
  process.stdout.write(renderReport(report, parsed.format));
  return 0;
}

type ParsedAuditArgs =
  | { ok: true; repo: string; format: ReportFormat }
  | { ok: false; error: string };

function parseAuditArgs(argv: string[]): ParsedAuditArgs {
  let repo = process.cwd();
  let format: ReportFormat = 'text';

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === '--repo') {
      repo = value;
      index += 1;
    } else if (arg === '--format') {
      if (!isReportFormat(value)) {
        return { ok: false, error: `Invalid format: ${value ?? ''}` };
      }
      format = value;
      index += 1;
    } else {
      return { ok: false, error: `Unknown argument: ${arg}` };
    }
  }

  return { ok: true, repo, format };
}

function isReportFormat(value: string | undefined): value is ReportFormat {
  return value === 'text' || value === 'markdown' || value === 'json' || value === 'github';
}

const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;

if (invokedPath) {
  process.exitCode = await main();
}

function usage(): string {
  return 'Usage: policymesh audit --repo <path> [--format text|markdown|json|github]';
}
