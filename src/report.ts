import type { Finding, MeshReport, ReportFormat, SurfaceId } from './types.js';

interface RenderOptions {
  githubAnnotationPathPrefix?: string;
}

export function renderReport(report: MeshReport, format: ReportFormat, options: RenderOptions = {}): string {
  if (format === 'json') {
    return `${JSON.stringify(report, null, 2)}\n`;
  }

  if (format === 'markdown') {
    return renderMarkdown(report);
  }

  if (format === 'github') {
    return renderGithubAnnotations(report, options.githubAnnotationPathPrefix);
  }

  return renderText(report);
}

function renderMarkdown(report: MeshReport): string {
  const lines = [`# PolicyMesh agent policy review: ${report.rating.toUpperCase()}`, ''];

  lines.push('## Effective capability union', '');
  for (const item of report.effectiveUnion) {
    lines.push(`- ${item}`);
  }
  lines.push('');

  if (report.matrix.length > 0) {
    lines.push('## Surface matrix', '');
    lines.push(`| Capability | ${SURFACE_COLUMNS.map(formatSurface).join(' | ')} |`);
    lines.push(`| --- | ${SURFACE_COLUMNS.map(() => '---').join(' | ')} |`);
    for (const row of report.matrix) {
      const capability = escapeMarkdownTableCell(row.capability);
      const cells = SURFACE_COLUMNS.map((surface) => escapeMarkdownTableCell(row.values[surface] ?? '-'));
      lines.push(`| ${capability} | ${cells.join(' | ')} |`);
    }
    lines.push('');
  }

  if (report.findings.length === 0) {
    lines.push('No cross-surface policy conflicts or gaps detected.');
    return `${lines.join('\n')}\n`;
  }

  lines.push(`This audit produced ${report.findingCount} finding${report.findingCount === 1 ? '' : 's'} across ${report.surfaceCount} configured surface${report.surfaceCount === 1 ? '' : 's'}.`, '');

  for (const severity of ['critical', 'high', 'medium', 'low'] as const) {
    const matches = report.findings.filter((finding) => finding.severity === severity);
    if (matches.length === 0) {
      continue;
    }

    lines.push(`## ${capitalize(severity)}`, '');
    for (const finding of matches) {
      lines.push(`- **${finding.subject}** (${finding.file}): ${finding.message}`);
      lines.push(`  Surfaces: ${formatSurfaceList(finding.surfaces)}`);
      lines.push(`  Recommendation: ${finding.recommendation}`);
    }
    lines.push('');
  }

  return `${lines.join('\n').trimEnd()}\n`;
}

function renderText(report: MeshReport): string {
  const lines = [`PolicyMesh agent policy review: ${report.rating.toUpperCase()}`];

  lines.push('', 'Effective capability union:');
  for (const item of report.effectiveUnion) {
    lines.push(`- ${item}`);
  }

  for (const finding of report.findings) {
    lines.push(`[${finding.severity.toUpperCase()}] ${finding.subject}: ${finding.message} Surfaces: ${formatSurfaceList(finding.surfaces)}.`);
  }

  if (report.findings.length === 0) {
    lines.push('No cross-surface policy conflicts or gaps detected.');
  }

  return `${lines.join('\n')}\n`;
}

function renderGithubAnnotations(report: MeshReport, pathPrefix?: string): string {
  if (report.findings.length === 0) {
    return '';
  }

  return report.findings
    .flatMap((finding) => {
      const title = `PolicyMesh ${finding.severity} finding`;
      const message = `${finding.message} Surfaces: ${formatSurfaceList(finding.surfaces)}. Recommendation: ${finding.recommendation}`;
      return annotationLocations(finding).map((location) => {
        const properties = [`file=${escapeProperty(prefixPath(location.file, pathPrefix))}`];
        if (location.line && location.line > 0) {
          properties.push(`line=${location.line}`);
        }
        properties.push(`title=${escapeProperty(title)}`);
        return `::warning ${properties.join(',')}::${escapeMessage(message)}`;
      });
    })
    .join('\n') + '\n';
}

const SURFACE_COLUMNS: SurfaceId[] = [
  'root_mcp',
  'cursor_mcp',
  'vscode_mcp',
  'windsurf_mcp',
  'claude',
  'codex'
];

const SURFACE_LABELS: Record<SurfaceId, string> = {
  root_mcp: 'Root MCP',
  cursor_mcp: 'Cursor MCP',
  vscode_mcp: 'VS Code MCP',
  windsurf_mcp: 'Codeium/Windsurf MCP',
  claude: 'Claude',
  codex: 'Codex'
};

function formatSurface(surface: SurfaceId): string {
  return SURFACE_LABELS[surface];
}

function formatSurfaceList(surfaces: SurfaceId[]): string {
  return surfaces.map(formatSurface).join(', ');
}

function annotationLocations(finding: Finding): Array<{ file: string; line?: number }> {
  return finding.locations?.length
    ? finding.locations.map((location) => ({ file: location.file, line: location.line }))
    : [{ file: finding.file, line: finding.line }];
}

function prefixPath(file: string, prefix?: string): string {
  if (!prefix) {
    return normalizePath(file);
  }

  return `${normalizePath(prefix).replace(/\/$/, '')}/${normalizePath(file).replace(/^\.\//, '')}`;
}

function normalizePath(file: string): string {
  return file.replaceAll('\\', '/');
}

function escapeMessage(value: string): string {
  return value
    .replaceAll('%', '%25')
    .replaceAll('\r', '%0D')
    .replaceAll('\n', '%0A');
}

function escapeProperty(value: string): string {
  return escapeMessage(value)
    .replaceAll(':', '%3A')
    .replaceAll(',', '%2C');
}

function escapeMarkdownTableCell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll(/\r?\n/g, '<br>');
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
