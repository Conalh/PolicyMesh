import type { MeshReport, ReportFormat, SurfaceId } from './types.js';

export function renderReport(report: MeshReport, format: ReportFormat): string {
  if (format === 'json') {
    return `${JSON.stringify(report, null, 2)}\n`;
  }

  if (format === 'markdown') {
    return renderMarkdown(report);
  }

  if (format === 'github') {
    return renderGithubAnnotations(report);
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
    lines.push(`| Capability | ${SURFACE_COLUMNS.join(' | ')} |`);
    lines.push(`| --- | ${SURFACE_COLUMNS.map(() => '---').join(' | ')} |`);
    for (const row of report.matrix) {
      const cells = SURFACE_COLUMNS.map((surface) => row.values[surface] ?? '—');
      lines.push(`| ${row.capability} | ${cells.join(' | ')} |`);
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
      lines.push(`  Surfaces: ${finding.surfaces.join(', ')}`);
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
    lines.push(`[${finding.severity.toUpperCase()}] ${finding.subject}: ${finding.message}`);
  }

  if (report.findings.length === 0) {
    lines.push('No cross-surface policy conflicts or gaps detected.');
  }

  return `${lines.join('\n')}\n`;
}

function renderGithubAnnotations(report: MeshReport): string {
  if (report.findings.length === 0) {
    return '';
  }

  return report.findings
    .map((finding) => {
      const title = `PolicyMesh ${finding.severity} policy conflict`;
      const message = `${finding.message} Recommendation: ${finding.recommendation}`;
      const properties = [`file=${escapeProperty(finding.file)}`];
      if (finding.line && finding.line > 0) {
        properties.push(`line=${finding.line}`);
      }
      properties.push(`title=${escapeProperty(title)}`);
      return `::warning ${properties.join(',')}::${escapeMessage(message)}`;
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

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
