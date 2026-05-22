#!/usr/bin/env node

import { stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRepo } from './audit.js';
import { auditRecursive } from './recursive.js';
import { renderReport } from './report.js';
import { applyEnabledStateFixes, formatFixPlan, planEnabledStateFixes } from './fix.js';
import type { ReportFormat, SurfaceId } from './types.js';

export { auditRepo } from './audit.js';
export type { MeshReport } from './types.js';

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }

  if (argv[0] === 'audit') {
    return runAudit(argv.slice(1));
  }

  if (argv[0] === 'fix') {
    return runFix(argv.slice(1));
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

  const repoError = await validateRepoPath(parsed.repo);
  if (repoError) {
    process.stderr.write(`${repoError}\n`);
    return 2;
  }

  const report = parsed.recursive
    ? await auditRecursive(parsed.repo)
    : await auditRepo(parsed.repo);
  process.stdout.write(renderReport(report, parsed.format, {
    githubAnnotationPathPrefix: githubAnnotationPathPrefix(parsed.repo)
  }));
  return 0;
}

type ParsedAuditArgs =
  | { ok: true; repo: string; format: ReportFormat; recursive: boolean }
  | { ok: false; error: string };

function parseAuditArgs(argv: string[]): ParsedAuditArgs {
  let repo = process.cwd();
  let format: ReportFormat = 'text';
  let recursive = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === '--repo') {
      if (!value || value.startsWith('--')) {
        return { ok: false, error: 'Missing value for --repo' };
      }
      repo = value;
      index += 1;
    } else if (arg === '--format') {
      if (!isReportFormat(value)) {
        return { ok: false, error: `Invalid format: ${value ?? ''}` };
      }
      format = value;
      index += 1;
    } else if (arg === '--recursive' || arg === '-r') {
      recursive = true;
    } else {
      return { ok: false, error: `Unknown argument: ${arg}` };
    }
  }

  return { ok: true, repo, format, recursive };
}

function isReportFormat(value: string | undefined): value is ReportFormat {
  return value === 'text' || value === 'markdown' || value === 'json' || value === 'github';
}

const SURFACE_IDS: SurfaceId[] = [
  'root_mcp',
  'cursor_mcp',
  'vscode_mcp',
  'codeium_mcp',
  'windsurf_mcp',
  'claude',
  'codex',
  'aider'
];

function isSurfaceId(value: string | undefined): value is SurfaceId {
  return SURFACE_IDS.includes(value as SurfaceId);
}

type ParsedFixArgs =
  | { ok: true; repo: string; canonical: SurfaceId; write: boolean }
  | { ok: false; error: string };

function parseFixArgs(argv: string[]): ParsedFixArgs {
  let repo = process.cwd();
  let canonical: SurfaceId | undefined;
  let write = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === '--repo') {
      if (!value || value.startsWith('--')) {
        return { ok: false, error: 'Missing value for --repo' };
      }
      repo = value;
      index += 1;
    } else if (arg === '--canonical') {
      if (!isSurfaceId(value)) {
        return { ok: false, error: `--canonical must be one of ${SURFACE_IDS.join(', ')}` };
      }
      canonical = value;
      index += 1;
    } else if (arg === '--write') {
      write = true;
    } else {
      return { ok: false, error: `Unknown argument: ${arg}` };
    }
  }

  if (!canonical) {
    return { ok: false, error: 'Missing required argument: --canonical <surface>' };
  }
  return { ok: true, repo, canonical, write };
}

async function runFix(argv: string[]): Promise<number> {
  const parsed = parseFixArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n${fixUsage()}\n`);
    return 2;
  }

  const repoError = await validateRepoPath(parsed.repo);
  if (repoError) {
    process.stderr.write(`${repoError}\n`);
    return 2;
  }

  try {
    const plan = await planEnabledStateFixes(parsed.repo, parsed.canonical);
    if (parsed.write) {
      const applied = await applyEnabledStateFixes(plan, parsed.repo, true);
      process.stdout.write(formatFixPlan(plan, applied));
      process.stdout.write('Note: --write reformats edited JSON files via JSON.stringify; comments and original indentation are not preserved.\n');
    } else {
      process.stdout.write(formatFixPlan(plan));
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
}

function githubAnnotationPathPrefix(repo: string): string | undefined {
  const prefix = relative(process.cwd(), resolve(repo));
  return prefix && prefix !== '.' && !prefix.startsWith('..') ? prefix : undefined;
}

async function validateRepoPath(repo: string): Promise<string | undefined> {
  try {
    const stats = await stat(repo);
    return stats.isDirectory() ? undefined : `Repository path is not a directory: ${repo}`;
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return `Repository path does not exist: ${repo}`;
    }
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}

const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;

if (invokedPath) {
  process.exitCode = await main();
}

function usage(): string {
  return [
    'Usage: policymesh audit --repo <path> [--format text|markdown|json|github] [--recursive]',
    `       ${fixUsage()}`
  ].join('\n');
}

function fixUsage(): string {
  return 'policymesh fix --repo <path> --canonical <surface> [--write]';
}
