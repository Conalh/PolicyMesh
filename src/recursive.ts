import { readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { auditRepo } from './audit.js';
import type { Finding, FindingLocation, MatrixRow, MeshRating, MeshReport, SurfaceId } from './types.js';

const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '__pycache__',
  '.venv',
  'venv'
]);

/**
 * Subdirectories that are themselves config containers, not project
 * roots. Walking into them would find a `.json` file at the leaf and
 * misidentify the container itself as a project; instead we stop at
 * the parent directory.
 */
const CONFIG_CONTAINERS = new Set([
  '.cursor',
  '.vscode',
  '.codeium',
  '.codex',
  '.claude',
  '.github'
]);

const PROJECT_MARKERS = [
  '.mcp.json',
  '.cursor/mcp.json',
  '.vscode/mcp.json',
  '.codeium/mcp_config.json',
  '.codeium/windsurf/mcp_config.json',
  '.codex/config.toml',
  '.claude/settings.json',
  '.aider.conf.yml',
  // Instruction-only surfaces. The instruction parser audits these, so a
  // monorepo package whose *only* agent config is an instruction file
  // (e.g. packages/foo/AGENTS.md with no MCP/Codex/Claude config) must
  // still be discovered as its own project. `.cursor/rules` is a
  // directory; stat() resolves directories as well as files.
  'AGENTS.md',
  'CLAUDE.md',
  '.github/copilot-instructions.md',
  '.cursor/rules'
];

export async function findProjectRoots(root: string): Promise<string[]> {
  const projects: string[] = [];
  await walk(root);
  return projects;

  async function walk(dir: string): Promise<void> {
    if (await directoryHasMarker(dir)) {
      projects.push(dir);
    }

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      if (IGNORE_DIRS.has(entry.name) || CONFIG_CONTAINERS.has(entry.name)) {
        continue;
      }
      await walk(join(dir, entry.name));
    }
  }
}

async function directoryHasMarker(dir: string): Promise<boolean> {
  for (const marker of PROJECT_MARKERS) {
    try {
      await stat(join(dir, marker));
      return true;
    } catch {
      // Missing marker — keep checking.
    }
  }
  return false;
}

export async function auditRecursive(root: string): Promise<MeshReport> {
  const projects = await findProjectRoots(root);
  if (projects.length === 0) {
    return auditRepo(root);
  }
  if (projects.length === 1 && projects[0] === root) {
    return auditRepo(root);
  }

  const reports = await Promise.all(projects.map(async (project) => {
    const report = await auditRepo(project);
    const prefix = relative(root, project) || '.';
    return prefixReport(report, prefix === '.' ? '' : prefix);
  }));

  return mergeReports(reports);
}

function prefixReport(report: MeshReport, prefix: string): MeshReport {
  if (!prefix) {
    return report;
  }
  const tag = `[${normalizePath(prefix)}]`;

  return {
    rating: report.rating,
    findingCount: report.findingCount,
    surfaceCount: report.surfaceCount,
    findings: report.findings.map((finding) => prefixFinding(finding, prefix)),
    effectiveUnion: report.effectiveUnion.map((item) => `${tag} ${item}`),
    matrix: report.matrix.map((row) => prefixMatrixRow(row, tag))
  };
}

function prefixFinding(finding: Finding, prefix: string): Finding {
  return {
    ...finding,
    file: joinPath(prefix, finding.file),
    locations: finding.locations?.map((location): FindingLocation => ({
      ...location,
      file: joinPath(prefix, location.file)
    }))
  };
}

function prefixMatrixRow(row: MatrixRow, tag: string): MatrixRow {
  return {
    capability: `${row.capability} ${tag}`,
    values: row.values
  };
}

function joinPath(prefix: string, file: string): string {
  if (!prefix) {
    return file;
  }
  return normalizePath(`${prefix}/${file}`);
}

function normalizePath(value: string): string {
  return value.split(sep).join('/').replace(/^\.\//, '');
}

function mergeReports(reports: MeshReport[]): MeshReport {
  const findings = reports.flatMap((report) => report.findings);
  const effectiveUnion = reports.flatMap((report) => report.effectiveUnion);
  const matrix = reports.flatMap((report) => report.matrix);
  const rating = highestRating(reports.map((report) => report.rating));
  const surfaceCount = reports.reduce((sum, report) => sum + report.surfaceCount, 0);

  return {
    rating,
    findingCount: findings.length,
    surfaceCount,
    findings,
    effectiveUnion,
    matrix
  };
}

function highestRating(ratings: MeshRating[]): MeshRating {
  const rank: Record<MeshRating, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
  let highest: MeshRating = 'none';
  for (const rating of ratings) {
    if (rank[rating] > rank[highest]) {
      highest = rating;
    }
  }
  return highest;
}

// SurfaceId is re-exported only to keep TS happy in downstream callers
// that import the merged report shape; the type itself is unchanged.
export type { SurfaceId };
