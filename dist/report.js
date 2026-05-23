import { selectConflictRows } from './mesh/engine.js';
export function renderReport(report, format, options = {}) {
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
function renderMarkdown(report) {
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
        }
        else {
            lines.push('No cross-surface policy conflicts or gaps detected.');
        }
        return `${lines.join('\n')}\n`;
    }
    lines.push(`This audit produced ${report.findingCount} finding${report.findingCount === 1 ? '' : 's'} across ${report.surfaceCount} configured surface${report.surfaceCount === 1 ? '' : 's'}.`, '');
    for (const severity of ['critical', 'high', 'medium', 'low']) {
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
function renderText(report) {
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
};
function colorEnabled() {
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
function bold(text, enabled) {
    return enabled ? `${ANSI.bold}${text}${ANSI.reset}` : text;
}
function severityColor(severity, text, enabled) {
    if (!enabled) {
        return text;
    }
    const codes = [];
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
function ratingColor(rating, enabled) {
    if (!enabled) {
        return rating.toUpperCase();
    }
    if (rating === 'none') {
        return `${ANSI.bold}${ANSI.green}NONE${ANSI.reset}`;
    }
    return severityColor(rating, rating.toUpperCase(), enabled);
}
function renderGithubAnnotations(report, pathPrefix) {
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
const SURFACE_COLUMNS = [
    'root_mcp',
    'cursor_mcp',
    'vscode_mcp',
    'codeium_mcp',
    'windsurf_mcp',
    'claude',
    'codex',
    'aider'
];
const SURFACE_LABELS = {
    root_mcp: 'Root MCP',
    cursor_mcp: 'Cursor MCP',
    vscode_mcp: 'VS Code MCP',
    codeium_mcp: 'Codeium MCP',
    windsurf_mcp: 'Windsurf MCP',
    claude: 'Claude',
    codex: 'Codex',
    aider: 'Aider'
};
function formatSurface(surface) {
    return SURFACE_LABELS[surface];
}
function formatSurfaceList(surfaces) {
    return surfaces.map(formatSurface).join(', ');
}
function annotationLocations(finding) {
    return finding.locations?.length
        ? finding.locations.map((location) => ({ file: location.file, line: location.line }))
        : [{ file: finding.file, line: finding.line }];
}
function prefixPath(file, prefix) {
    if (!prefix) {
        return normalizePath(file);
    }
    return `${normalizePath(prefix).replace(/\/$/, '')}/${normalizePath(file).replace(/^\.\//, '')}`;
}
function normalizePath(file) {
    return file.replaceAll('\\', '/');
}
function escapeMessage(value) {
    return value
        .replaceAll('%', '%25')
        .replaceAll('\r', '%0D')
        .replaceAll('\n', '%0A');
}
function escapeProperty(value) {
    return escapeMessage(value)
        .replaceAll(':', '%3A')
        .replaceAll(',', '%2C');
}
function escapeMarkdownTableCell(value) {
    return value.replaceAll('|', '\\|').replaceAll(/\r?\n/g, '<br>');
}
function capitalize(value) {
    return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
