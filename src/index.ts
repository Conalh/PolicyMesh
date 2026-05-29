#!/usr/bin/env node

import { stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isValidGitRef } from 'agent-gov-core';
import { auditRepo } from './audit.js';
import { auditRecursive } from './recursive.js';
import { fromCanonicalReport, renderReport } from './report.js';
import { applyEnabledStateFixes, applyPinFixes, formatFixPlan, formatPinPlan, planEnabledStateFixes, planPinFixes } from './fix.js';
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

  if (argv[0] === 'render') {
    return runRender(argv.slice(1));
  }

  if (argv[0] === 'diff') {
    return runDiff(argv.slice(1));
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
  return value === 'text' || value === 'markdown' || value === 'json' || value === 'github' || value === 'sarif';
}

const SURFACE_IDS: SurfaceId[] = [
  'root_mcp',
  'cursor_mcp',
  'vscode_mcp',
  'codeium_mcp',
  'windsurf_mcp',
  'claude',
  'codex',
  'aider',
  'instructions'
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
  // `policymesh fix pin ...` routes to the pin-alignment branch.
  // `policymesh fix ...` keeps the v0.3.0 enabled-state behavior.
  if (argv[0] === 'pin') {
    return runFixPin(argv.slice(1));
  }

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
    } else {
      process.stdout.write(formatFixPlan(plan));
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
}

async function runFixPin(argv: string[]): Promise<number> {
  const parsed = parseFixArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n${fixPinUsage()}\n`);
    return 2;
  }

  const repoError = await validateRepoPath(parsed.repo);
  if (repoError) {
    process.stderr.write(`${repoError}\n`);
    return 2;
  }

  try {
    const plan = await planPinFixes(parsed.repo, parsed.canonical);
    if (parsed.write) {
      const applied = await applyPinFixes(plan, parsed.repo, true);
      process.stdout.write(formatPinPlan(plan, applied));
    } else {
      process.stdout.write(formatPinPlan(plan));
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
}

function fixPinUsage(): string {
  return 'policymesh fix pin --repo <path> --canonical <surface> [--write]';
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
    'Usage: policymesh audit --repo <path> [--format text|markdown|json|github|sarif] [--recursive]',
    `       ${fixUsage()}`,
    `       ${fixPinUsage()}`,
    `       ${renderUsage()}`,
    `       ${diffUsage()}`
  ].join('\n');
}

function diffUsage(): string {
  return [
    'policymesh diff --base-report <json-file> --head-report <json-file> [--format ...] [--annotation-path-prefix <path>]',
    '       policymesh diff --base-ref <git-ref> [--head-ref <git-ref>] [--repo <path>] [--recursive] [--format ...]'
  ].join('\n');
}

type ParsedDiffArgs =
  | { ok: true; mode: 'reports'; base: string; head: string; format: ReportFormat; annotationPathPrefix?: string }
  | { ok: true; mode: 'refs'; baseRef: string; headRef: string; repo: string; recursive: boolean; format: ReportFormat; annotationPathPrefix?: string }
  | { ok: false; error: string };

function parseDiffArgs(argv: string[]): ParsedDiffArgs {
  let base: string | undefined;
  let head: string | undefined;
  let baseRef: string | undefined;
  let headRef = 'HEAD';
  let repo = process.cwd();
  let recursive = false;
  let format: ReportFormat = 'text';
  let annotationPathPrefix: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === '--base-report') {
      if (!value || value.startsWith('--')) {
        return { ok: false, error: 'Missing value for --base-report' };
      }
      base = value;
      index += 1;
    } else if (arg === '--head-report') {
      if (!value || value.startsWith('--')) {
        return { ok: false, error: 'Missing value for --head-report' };
      }
      head = value;
      index += 1;
    } else if (arg === '--base-ref') {
      if (!value || value.startsWith('--')) {
        return { ok: false, error: 'Missing value for --base-ref' };
      }
      baseRef = value;
      index += 1;
    } else if (arg === '--head-ref') {
      if (!value || value.startsWith('--')) {
        return { ok: false, error: 'Missing value for --head-ref' };
      }
      headRef = value;
      index += 1;
    } else if (arg === '--repo') {
      if (!value || value.startsWith('--')) {
        return { ok: false, error: 'Missing value for --repo' };
      }
      repo = value;
      index += 1;
    } else if (arg === '--recursive' || arg === '-r') {
      recursive = true;
    } else if (arg === '--format') {
      if (!isReportFormat(value)) {
        return { ok: false, error: `Invalid format: ${value ?? ''}` };
      }
      format = value;
      index += 1;
    } else if (arg === '--annotation-path-prefix') {
      if (!value) {
        return { ok: false, error: 'Missing value for --annotation-path-prefix' };
      }
      annotationPathPrefix = value;
      index += 1;
    } else {
      return { ok: false, error: `Unknown argument: ${arg}` };
    }
  }

  if (baseRef !== undefined) {
    return { ok: true, mode: 'refs', baseRef, headRef, repo, recursive, format, annotationPathPrefix };
  }
  if (!base) {
    return { ok: false, error: 'Missing required argument: pass --base-ref <git-ref> for local diff, or --base-report <json-file> when diffing saved audits' };
  }
  if (!head) {
    return { ok: false, error: 'Missing required argument: --head-report <json-file>' };
  }
  return { ok: true, mode: 'reports', base, head, format, annotationPathPrefix };
}

async function runDiff(argv: string[]): Promise<number> {
  const parsed = parseDiffArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n${diffUsage()}\n`);
    return 2;
  }

  const { diffReports } = await import('./diff.js');

  if (parsed.mode === 'refs') {
    return runDiffRefs(parsed, diffReports);
  }

  const { readFile } = await import('node:fs/promises');
  let baseReport;
  let headReport;
  try {
    // Saved reports are canonical envelopes since v0.2.0; rehydrate them
    // back into MeshReport so diffReports/renderReport (internal-shape APIs)
    // continue to work unchanged.
    baseReport = fromCanonicalReport(JSON.parse(await readFile(parsed.base, 'utf8')));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      process.stderr.write(`Base report not found: ${parsed.base}\n`);
      return 2;
    }
    process.stderr.write(`Could not read base report: ${(error as Error).message}\n`);
    return 2;
  }
  try {
    headReport = fromCanonicalReport(JSON.parse(await readFile(parsed.head, 'utf8')));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      process.stderr.write(`Head report not found: ${parsed.head}\n`);
      return 2;
    }
    process.stderr.write(`Could not read head report: ${(error as Error).message}\n`);
    return 2;
  }

  const delta = diffReports(baseReport, headReport);
  process.stdout.write(renderReport(delta, parsed.format, {
    githubAnnotationPathPrefix: parsed.annotationPathPrefix
  }));
  return 0;
}

interface DiffRefsArgs {
  mode: 'refs';
  baseRef: string;
  headRef: string;
  repo: string;
  recursive: boolean;
  format: ReportFormat;
  annotationPathPrefix?: string;
}

async function runDiffRefs(
  parsed: DiffRefsArgs,
  diffReports: (base: import('./types.js').MeshReport, head: import('./types.js').MeshReport) => import('./types.js').MeshReport
): Promise<number> {
  const repoError = await validateRepoPath(parsed.repo);
  if (repoError) {
    process.stderr.write(`${repoError}\n`);
    return 2;
  }

  const { spawnSync } = await import('node:child_process');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  // head audit always runs against the working tree (or --repo override)
  // so an in-progress branch is what gets compared. To compare two
  // committed refs, point --repo at a checkout of each. v1 keeps
  // --head-ref accepting "HEAD" only and validates that explicitly.
  if (parsed.headRef !== 'HEAD') {
    process.stderr.write(`--head-ref currently supports "HEAD" only. To diff two refs, audit each separately and use --base-report / --head-report.\n`);
    return 2;
  }

  // String-level argument-injection guard, shared across the suite via
  // agent-gov-core. spawnSync (no shell) blocks shell metacharacters, but
  // git re-parses a positional ref against its own option table — so a
  // `-`-leading --base-ref (`--upload-pack=...`) is a flag-injection
  // vector and a `:` would re-anchor an object selector. Reject those
  // (and control chars) before the value reaches git.
  if (!isValidGitRef(parsed.baseRef)) {
    process.stderr.write(`Invalid --base-ref "${parsed.baseRef}". Refs cannot start with "-", contain ":", or include control characters.\n`);
    return 2;
  }

  // Resolve the base ref via the working repo. This catches "ref does
  // not exist locally" before we create a worktree.
  const revParse = spawnSync('git', ['-C', parsed.repo, 'rev-parse', '--verify', parsed.baseRef], { encoding: 'utf8' });
  if (revParse.status !== 0) {
    process.stderr.write(`Could not resolve --base-ref "${parsed.baseRef}" in ${parsed.repo}. Is the ref local? (try git fetch first)\n`);
    return 2;
  }
  const baseSha = revParse.stdout.trim();

  const worktreeDir = await mkdtemp(join(tmpdir(), 'policymesh-base-'));
  const worktreeAdd = spawnSync(
    'git',
    ['-C', parsed.repo, 'worktree', 'add', '--detach', worktreeDir, baseSha],
    { encoding: 'utf8' }
  );
  if (worktreeAdd.status !== 0) {
    await rm(worktreeDir, { recursive: true, force: true });
    process.stderr.write(`git worktree add failed: ${worktreeAdd.stderr}\n`);
    return 2;
  }

  try {
    const baseReport = parsed.recursive
      ? await auditRecursive(worktreeDir)
      : await auditRepo(worktreeDir);
    const headReport = parsed.recursive
      ? await auditRecursive(parsed.repo)
      : await auditRepo(parsed.repo);

    const delta = diffReports(baseReport, headReport);
    process.stdout.write(renderReport(delta, parsed.format, {
      githubAnnotationPathPrefix: parsed.annotationPathPrefix
    }));
    return 0;
  } finally {
    spawnSync('git', ['-C', parsed.repo, 'worktree', 'remove', '--force', worktreeDir], { encoding: 'utf8' });
    await rm(worktreeDir, { recursive: true, force: true });
  }
}

function fixUsage(): string {
  return 'policymesh fix --repo <path> --canonical <surface> [--write]';
}

function renderUsage(): string {
  return 'policymesh render --input <json-file> --format text|markdown|json|github|sarif [--annotation-path-prefix <path>]';
}

type ParsedRenderArgs =
  | { ok: true; input: string; format: ReportFormat; annotationPathPrefix?: string }
  | { ok: false; error: string };

function parseRenderArgs(argv: string[]): ParsedRenderArgs {
  let input: string | undefined;
  let format: ReportFormat | undefined;
  let annotationPathPrefix: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = argv[index + 1];

    if (arg === '--input') {
      if (!value || value.startsWith('--')) {
        return { ok: false, error: 'Missing value for --input' };
      }
      input = value;
      index += 1;
    } else if (arg === '--format') {
      if (!isReportFormat(value)) {
        return { ok: false, error: `Invalid format: ${value ?? ''}` };
      }
      format = value;
      index += 1;
    } else if (arg === '--annotation-path-prefix') {
      if (!value) {
        return { ok: false, error: 'Missing value for --annotation-path-prefix' };
      }
      annotationPathPrefix = value;
      index += 1;
    } else {
      return { ok: false, error: `Unknown argument: ${arg}` };
    }
  }

  if (!input) {
    return { ok: false, error: 'Missing required argument: --input <json-file>' };
  }
  if (!format) {
    return { ok: false, error: 'Missing required argument: --format <fmt>' };
  }
  return { ok: true, input, format, annotationPathPrefix };
}

async function runRender(argv: string[]): Promise<number> {
  const parsed = parseRenderArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n${renderUsage()}\n`);
    return 2;
  }

  const { readFile } = await import('node:fs/promises');
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(await readFile(parsed.input, 'utf8'));
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      process.stderr.write(`Input report not found: ${parsed.input}\n`);
      return 2;
    }
    process.stderr.write(`Could not read report JSON at ${parsed.input}: ${(error as Error).message}\n`);
    return 2;
  }

  // `render` accepts only the canonical Report envelope as of v0.2.0; pre-
  // 0.2.0 MeshReport JSON is rejected with a pointer to the migration.
  let report;
  try {
    report = fromCanonicalReport(parsedJson);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  process.stdout.write(renderReport(report, parsed.format, {
    githubAnnotationPathPrefix: parsed.annotationPathPrefix
  }));
  return 0;
}
