import { readFile, writeFile } from 'node:fs/promises';
import { stripJsonComments } from 'agent-gov-core';
import { parseRepoPolicies } from './parsers/index.js';
import { configPath, lineOfJsonKey } from './discovery.js';
const JSON_MCP_SURFACES = [
    'root_mcp',
    'cursor_mcp',
    'vscode_mcp',
    'codeium_mcp',
    'windsurf_mcp'
];
/**
 * Cursor's MCP config historically uses `disabled` while every other
 * JSON MCP surface uses `enabled`. When we need to introduce the key
 * (it does not yet exist on the server object) we honour the surface's
 * convention; when the key already exists, we leave that key choice
 * alone and only update its value.
 */
const PREFERRED_KEY = {
    root_mcp: 'enabled',
    cursor_mcp: 'disabled',
    vscode_mcp: 'enabled',
    codeium_mcp: 'enabled',
    windsurf_mcp: 'enabled',
    claude: 'enabled',
    codex: 'enabled',
    aider: 'enabled',
    instructions: 'enabled'
};
export async function planEnabledStateFixes(root, canonical) {
    if (!JSON_MCP_SURFACES.includes(canonical)) {
        throw new Error(`--canonical must be a JSON MCP surface in v1 (one of ${JSON_MCP_SURFACES.join(', ')}); got "${canonical}".`);
    }
    const policies = await parseRepoPolicies(root);
    const canonicalServers = serversBySurface(policies, canonical);
    const fixes = [];
    for (const surface of policies.mcpSurfaces) {
        if (surface.surfaceId === canonical) {
            continue;
        }
        if (!JSON_MCP_SURFACES.includes(surface.surfaceId)) {
            continue;
        }
        for (const server of surface.servers) {
            const canonicalServer = canonicalServers.get(server.name);
            if (!canonicalServer) {
                continue;
            }
            if (server.enabled === canonicalServer.enabled) {
                continue;
            }
            fixes.push({
                file: server.file,
                surface: server.surfaceId,
                server: server.name,
                before: server.enabled,
                after: canonicalServer.enabled,
                description: `Align "${server.name}" enabled=${canonicalServer.enabled} (was ${server.enabled}) in ${server.file}`
            });
        }
    }
    return { canonical, fixes, skipped: [] };
}
function serversBySurface(policies, surfaceId) {
    const surface = policies.mcpSurfaces.find((entry) => entry.surfaceId === surfaceId);
    const map = new Map();
    if (!surface) {
        return map;
    }
    for (const server of surface.servers) {
        map.set(server.name, server);
    }
    return map;
}
export async function applyEnabledStateFixes(plan, root, write) {
    const applied = [];
    const skipped = [];
    // Group fixes by file so we read/edit each config at most once.
    const byFile = new Map();
    for (const fix of plan.fixes) {
        const existing = byFile.get(fix.file) ?? [];
        existing.push(fix);
        byFile.set(fix.file, existing);
    }
    for (const [file, fileFixes] of byFile) {
        const fullPath = configPath(root, file);
        const originalText = await readFile(fullPath, 'utf8');
        const editor = new JsonLineEditor(originalText);
        for (const fix of fileFixes) {
            const result = editor.alignEnabledState(fix.server, fix.after, fix.surface);
            if (result.ok) {
                applied.push(fix);
            }
            else {
                skipped.push({ fix, reason: result.reason });
            }
        }
        if (editor.mutated() && write) {
            await writeFile(fullPath, editor.text(), 'utf8');
        }
    }
    return { applied, skipped };
}
/**
 * Line-targeted JSONC editor. We deliberately do NOT round-trip the file
 * through JSON.parse / JSON.stringify because that strips comments,
 * trailing commas, and the team's original indentation — exactly the
 * formatting choices that make a config human-readable in code review.
 *
 * Instead, we locate the relevant `enabled` or `disabled` line by
 * walking the comment-stripped text with brace counting (so we never
 * confuse a nested object's `enabled` with the server's own), then
 * splice the value on the original line. Everything else in the file
 * is byte-identical to what the user authored.
 */
class JsonLineEditor {
    lines;
    mutatedFlag = false;
    constructor(originalText) {
        this.lines = originalText.split(/\r?\n/);
    }
    mutated() {
        return this.mutatedFlag;
    }
    text() {
        return this.lines.join('\n');
    }
    alignEnabledState(serverName, enabled, surface) {
        const original = this.text();
        const stripped = stripJsonComments(original);
        const serverKeyLine = lineOfJsonKey(stripped, serverName);
        if (!serverKeyLine) {
            return { ok: false, reason: 'server entry not found in file' };
        }
        const block = findServerBlock(stripped, serverKeyLine);
        if (!block) {
            return { ok: false, reason: 'could not locate server block braces' };
        }
        const existing = findEnabledOrDisabledLine(stripped, block);
        if (existing) {
            // In-place value replacement — preserves indentation, comments
            // on the line, trailing commas, everything.
            const newValue = existing.key === 'enabled' ? String(enabled) : String(!enabled);
            const updated = replaceBooleanValue(this.lines[existing.lineIndex], existing.key, newValue);
            if (!updated) {
                return { ok: false, reason: 'value replacement could not locate boolean token' };
            }
            this.lines[existing.lineIndex] = updated;
            this.mutatedFlag = true;
            return { ok: true };
        }
        // Field absent — insertion path. Determine child indent and any
        // trailing-comma convention from existing children, then splice a
        // new line in just before the server block's closing brace.
        const inserted = insertEnabledLine(this.lines, block, surface, enabled);
        if (!inserted.ok) {
            return inserted;
        }
        this.mutatedFlag = true;
        return { ok: true };
    }
}
function findServerBlock(stripped, serverKeyLine) {
    const lines = stripped.split(/\r?\n/);
    // Find the first '{' on or after the server key line.
    let openLine = -1;
    for (let i = serverKeyLine - 1; i < lines.length; i += 1) {
        if (lines[i].includes('{')) {
            openLine = i;
            break;
        }
    }
    if (openLine < 0) {
        return undefined;
    }
    // From the first '{' on openLine, count braces (respecting strings)
    // until depth returns to zero.
    let depth = 0;
    let started = false;
    let inString = false;
    let escape = false;
    for (let i = openLine; i < lines.length; i += 1) {
        const line = lines[i];
        for (let c = 0; c < line.length; c += 1) {
            const ch = line[c];
            if (inString) {
                if (escape) {
                    escape = false;
                }
                else if (ch === '\\') {
                    escape = true;
                }
                else if (ch === '"') {
                    inString = false;
                }
                continue;
            }
            if (ch === '"') {
                inString = true;
                continue;
            }
            if (ch === '{') {
                depth += 1;
                started = true;
            }
            else if (ch === '}') {
                depth -= 1;
                if (started && depth === 0) {
                    return { openLine, closeLine: i };
                }
            }
        }
    }
    return undefined;
}
function findEnabledOrDisabledLine(stripped, block) {
    const lines = stripped.split(/\r?\n/);
    // We only care about fields DIRECTLY inside the server block, not
    // nested under a child object. Track depth from the open brace.
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = block.openLine; i <= block.closeLine; i += 1) {
        const line = lines[i];
        // Within the body of the server block (depth === 1 after the
        // opening brace), inspect for the enabled/disabled key. Skip the
        // open-line's content before the brace and the close-line's
        // content after.
        const isDirectChildLine = depth === 1 && i > block.openLine;
        if (isDirectChildLine) {
            const match = /"(enabled|disabled)"\s*:\s*(true|false)/.exec(line);
            if (match) {
                return { lineIndex: i, key: match[1] };
            }
        }
        // Update depth/state at end of the line by replaying chars.
        for (let c = 0; c < line.length; c += 1) {
            const ch = line[c];
            if (inString) {
                if (escape) {
                    escape = false;
                }
                else if (ch === '\\') {
                    escape = true;
                }
                else if (ch === '"') {
                    inString = false;
                }
                continue;
            }
            if (ch === '"') {
                inString = true;
                continue;
            }
            if (ch === '{') {
                depth += 1;
            }
            else if (ch === '}') {
                depth -= 1;
            }
        }
    }
    return undefined;
}
function replaceBooleanValue(line, key, newValue) {
    const regex = new RegExp(`("${key}"\\s*:\\s*)(true|false)`);
    if (!regex.test(line)) {
        return undefined;
    }
    return line.replace(regex, `$1${newValue}`);
}
function insertEnabledLine(lines, block, surface, enabled) {
    const key = PREFERRED_KEY[surface];
    const value = key === 'enabled' ? enabled : !enabled;
    // Sample the indent of the first non-empty line strictly between
    // openLine and closeLine. If the block is empty, indent the new
    // line by adding two spaces to the open line's indent.
    let childIndent;
    for (let i = block.openLine + 1; i < block.closeLine; i += 1) {
        const m = /^(\s+)\S/.exec(lines[i]);
        if (m) {
            childIndent = m[1];
            break;
        }
    }
    if (childIndent === undefined) {
        const openIndentMatch = /^(\s*)/.exec(lines[block.openLine]);
        childIndent = `${openIndentMatch?.[1] ?? ''}  `;
    }
    // Find the previous non-empty line inside the block. If it ends in a
    // value or `]` or `}` without a trailing comma, add one.
    let previousNonEmpty = -1;
    for (let i = block.closeLine - 1; i > block.openLine; i -= 1) {
        if (lines[i].trim().length > 0) {
            previousNonEmpty = i;
            break;
        }
    }
    if (previousNonEmpty < 0) {
        return { ok: false, reason: 'cannot insert into empty server block in v1' };
    }
    const prev = lines[previousNonEmpty];
    const prevTrim = prev.replace(/\s+$/, '');
    if (!/[,]\s*(?:\/\/.*)?$/.test(prevTrim) && !prevTrim.endsWith(',')) {
        lines[previousNonEmpty] = `${prevTrim},${prev.slice(prevTrim.length)}`;
    }
    const newLine = `${childIndent}"${key}": ${value}`;
    lines.splice(block.closeLine, 0, newLine);
    return { ok: true };
}
export function formatFixPlan(plan, applied) {
    const lines = [];
    lines.push(`PolicyMesh fix plan against canonical surface: ${plan.canonical}`);
    if (plan.fixes.length === 0) {
        lines.push('No mcp_enabled_mismatch findings to align.');
        return `${lines.join('\n')}\n`;
    }
    if (applied) {
        lines.push(`Applied ${applied.applied.length} edit(s), skipped ${applied.skipped.length}.`);
    }
    else {
        lines.push(`Would apply ${plan.fixes.length} edit(s). Re-run with --write to persist.`);
    }
    for (const fix of plan.fixes) {
        lines.push(`- ${fix.description}`);
    }
    if (applied && applied.skipped.length > 0) {
        lines.push('Skipped:');
        for (const skip of applied.skipped) {
            lines.push(`- ${skip.fix.description} (${skip.reason})`);
        }
    }
    return `${lines.join('\n')}\n`;
}
