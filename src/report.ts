import { selectConflictRows } from './mesh/engine.js';
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

  if (format === 'sarif') {
    return renderSarif(report, options.githubAnnotationPathPrefix);
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
    const conflictRows = selectConflictRows(report.matrix);
    if (conflictRows.length > 0) {
      lines.push('## Surface matrix — conflicts', '');
      lines.push('Rows where 2+ surfaces disagree. Aligned rows are in the full matrix below.', '');
      lines.push(`| Capability | ${SURFACE_COLUMNS.map(formatSurface).join(' | ')} |`);
      lines.push(`| --- | ${SURFACE_COLUMNS.map(() => '---').join(' | ')} |`);
      for (const row of conflictRows) {
        const capability = escapeMarkdownTableCell(row.capability);
        const cells = SURFACE_COLUMNS.map((surface) => escapeMarkdownTableCell(row.values[surface] ?? '-'));
        lines.push(`| ${capability} | ${cells.join(' | ')} |`);
      }
      lines.push('');
    }

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

  // In diff mode, surface findings resolved by this PR before listing
  // new/worsened findings — green-check signal alongside the warnings.
  if (report.resolvedFindings && report.resolvedFindings.length > 0) {
    const count = report.resolvedFindings.length;
    lines.push(`## Resolved by this PR (${count})`, '');
    for (const finding of report.resolvedFindings) {
      lines.push(`- **${finding.subject}** (${finding.file}): ${finding.message}`);
    }
    lines.push('');
  }

  if (report.findings.length === 0) {
    if (report.resolvedFindings && report.resolvedFindings.length > 0) {
      lines.push(`This PR resolved ${report.resolvedFindings.length} pre-existing finding${report.resolvedFindings.length === 1 ? '' : 's'} and introduced no new ones.`);
    } else {
      lines.push('No cross-surface policy conflicts or gaps detected.');
    }
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
  const color = colorEnabled();
  const lines = [
    `${bold('PolicyMesh agent policy review:', color)} ${ratingColor(report.rating, color)}`
  ];

  lines.push('', bold('Effective capability union:', color));
  for (const item of report.effectiveUnion) {
    lines.push(`- ${item}`);
  }

  for (const finding of report.findings) {
    const tag = `[${finding.severity.toUpperCase()}]`;
    const coloredTag = severityColor(finding.severity, tag, color);
    lines.push(`${coloredTag} ${finding.subject}: ${finding.message} Surfaces: ${formatSurfaceList(finding.surfaces)}.`);
  }

  if (report.findings.length === 0) {
    lines.push(severityColor('low', 'No cross-surface policy conflicts or gaps detected.', color));
  }

  return `${lines.join('\n')}\n`;
}

const ANSI = {
  reset: '[0m',
  bold: '[1m',
  red: '[31m',
  brightRed: '[91m',
  yellow: '[33m',
  cyan: '[36m',
  green: '[32m'
} as const;

function colorEnabled(): boolean {
  // NO_COLOR (https://no-color.org/) wins unconditionally.
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }
  // FORCE_COLOR opts in even when stdout is not a TTY — useful for CI
  // logs that render ANSI from captured output.
  if (process.env.FORCE_COLOR && process.env.FORCE_COLOR !== '0') {
    return true;
  }
  return Boolean(process.stdout.isTTY);
}

function bold(text: string, enabled: boolean): string {
  return enabled ? `${ANSI.bold}${text}${ANSI.reset}` : text;
}

function severityColor(severity: string, text: string, enabled: boolean): string {
  if (!enabled) {
    return text;
  }
  const codes: string[] = [];
  switch (severity) {
    case 'critical':
      codes.push(ANSI.bold, ANSI.brightRed);
      break;
    case 'high':
      codes.push(ANSI.bold, ANSI.red);
      break;
    case 'medium':
      codes.push(ANSI.yellow);
      break;
    case 'low':
      codes.push(ANSI.cyan);
      break;
    default:
      return text;
  }
  return `${codes.join('')}${text}${ANSI.reset}`;
}

function ratingColor(rating: string, enabled: boolean): string {
  if (!enabled) {
    return rating.toUpperCase();
  }
  if (rating === 'none') {
    return `${ANSI.bold}${ANSI.green}NONE${ANSI.reset}`;
  }
  return severityColor(rating, rating.toUpperCase(), enabled);
}

/**
 * SARIF 2.1.0 output for ingestion via GitHub's `upload-sarif` action,
 * GitLab SAST, and any other tooling that consumes the standard format.
 *
 * Severity mapping follows SARIF conventions: critical and high map to
 * "error", medium to "warning", low to "note". Each unique finding kind
 * becomes a rule definition under tool.driver.rules so the GitHub
 * Security tab can render rule details and link back to the
 * recommendation text. Per-finding signatures populate
 * partialFingerprints so SARIF ingestors can deduplicate across runs.
 */
function renderSarif(report: MeshReport, pathPrefix?: string): string {
  const ruleIds = [...new Set(report.findings.map((finding) => finding.kind))].sort();
  const rules = ruleIds.map((id) => {
    const example = report.findings.find((finding) => finding.kind === id);
    return {
      id,
      name: ruleNameForKind(id),
      shortDescription: { text: shortDescriptionForKind(id) },
      fullDescription: { text: example?.recommendation ?? shortDescriptionForKind(id) },
      defaultConfiguration: { level: sarifLevelForSeverity(example?.severity) },
      helpUri: 'https://github.com/Conalh/PolicyMesh#current-findings'
    };
  });

  const results = report.findings.map((finding) => {
    const locations = annotationLocations(finding).map((location) => ({
      physicalLocation: {
        artifactLocation: { uri: prefixPath(location.file, pathPrefix) },
        ...(location.line && location.line > 0
          ? { region: { startLine: location.line } }
          : {})
      }
    }));

    const partialFingerprints = finding.signature
      ? { policymeshSignature: finding.signature }
      : undefined;

    return {
      ruleId: finding.kind,
      ruleIndex: ruleIds.indexOf(finding.kind),
      level: sarifLevelForSeverity(finding.severity),
      message: {
        text: `${finding.message} Surfaces: ${formatSurfaceList(finding.surfaces)}. Recommendation: ${finding.recommendation}`
      },
      locations,
      ...(partialFingerprints ? { partialFingerprints } : {}),
      properties: {
        severity: finding.severity,
        subject: finding.subject,
        surfaces: finding.surfaces
      }
    };
  });

  const sarif = {
    version: '2.1.0',
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    runs: [{
      tool: {
        driver: {
          name: 'PolicyMesh',
          informationUri: 'https://github.com/Conalh/PolicyMesh',
          rules
        }
      },
      results
    }]
  };

  return `${JSON.stringify(sarif, null, 2)}\n`;
}

function sarifLevelForSeverity(severity: string | undefined): 'error' | 'warning' | 'note' {
  switch (severity) {
    case 'critical':
    case 'high':
      return 'error';
    case 'medium':
      return 'warning';
    default:
      return 'note';
  }
}

function ruleNameForKind(kind: string): string {
  // policy_mesh.mcp_command_mismatch -> McpCommandMismatch
  const tail = kind.includes('.') ? kind.slice(kind.lastIndexOf('.') + 1) : kind;
  return tail
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

function shortDescriptionForKind(kind: string): string {
  const descriptions: Record<string, string> = {
    'policy_mesh.mcp_command_mismatch': 'MCP server has different launch commands across surfaces.',
    'policy_mesh.mcp_server_missing': 'MCP server is defined on some surfaces but missing from others.',
    'policy_mesh.mcp_enabled_mismatch': 'MCP server enabled/disabled state differs across surfaces.',
    'policy_mesh.mcp_env_mismatch': 'MCP server environment variables differ across surfaces.',
    'policy_mesh.mcp_header_mismatch': 'MCP server remote headers differ across surfaces.',
    'policy_mesh.mcp_unpinned': 'MCP server uses an unpinned command (@latest or similar).',
    'policy_mesh.hardcoded_secret': 'MCP server appears to embed a hardcoded API credential.',
    'policy_mesh.missing_local_script': 'MCP server references a local script that does not exist.',
    'policy_mesh.privileged_command': 'MCP server launches via an elevation utility (sudo, runas, etc.).',
    'policy_mesh.claude_mcp_grant_missing_server': 'Claude grants an MCP server that is not defined in any MCP config.',
    'policy_mesh.claude_deny_allow_overlap': 'Claude broad allow rules overlap with sensitive deny rules.',
    'policy_mesh.claude_broad_allow_no_guard': 'Claude broad allow rules without a PreToolUse guard hook.',
    'policy_mesh.codex_network_without_review': 'Codex network access enabled alongside other agent surfaces.',
    'policy_mesh.codex_trusted_with_risky_mcp': 'Codex project trusted while MCP is unpinned or inconsistent.',
    'policy_mesh.codex_claude_posture_gap': 'Codex sandbox posture inconsistent with Claude deny rules.',
    'policy_mesh.aider_dangerous_allow_non_git': 'Aider bypasses the git-tracked audit trail.',
    'policy_mesh.config_parse_error': 'Agent config file could not be parsed.',
    'policy_mesh.exceptions_parse_error': 'Exceptions baseline file could not be parsed.'
  };
  return descriptions[kind] ?? kind;
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
  'codeium_mcp',
  'windsurf_mcp',
  'claude',
  'codex',
  'aider'
];

const SURFACE_LABELS: Record<SurfaceId, string> = {
  root_mcp: 'Root MCP',
  cursor_mcp: 'Cursor MCP',
  vscode_mcp: 'VS Code MCP',
  codeium_mcp: 'Codeium MCP',
  windsurf_mcp: 'Windsurf MCP',
  claude: 'Claude',
  codex: 'Codex',
  aider: 'Aider'
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
