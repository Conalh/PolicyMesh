import { configPath, isRecord, lineOfJsonStringValue, readJsonObjectWithSource } from '../discovery.js';
import { configParseFinding } from './errors.js';
const CLAUDE_SETTINGS_FILE = '.claude/settings.json';
export async function parseClaudePolicy(root) {
    const source = await readJsonObjectWithSource(configPath(root, CLAUDE_SETTINGS_FILE));
    if (!source.text.trim()) {
        return { findings: [] };
    }
    if (source.parseError) {
        return {
            findings: [configParseFinding(CLAUDE_SETTINGS_FILE, 'claude', source.parseError)]
        };
    }
    const json = source.json;
    const permissions = isRecord(json.permissions) ? json.permissions : {};
    const hooks = isRecord(json.hooks) ? json.hooks : {};
    const allow = readStringArrayWithLines(permissions.allow, source.text);
    const deny = readStringArrayWithLines(permissions.deny, source.text);
    const hookNames = new Set(Object.entries(hooks)
        .filter(([, value]) => hookHasEntries(value))
        .map(([name]) => name));
    if (allow.size === 0 && deny.size === 0 && hookNames.size === 0) {
        return { findings: [] };
    }
    return {
        policy: {
            surfaceId: 'claude',
            file: CLAUDE_SETTINGS_FILE,
            allow,
            deny,
            hooks: hookNames
        },
        findings: []
    };
}
// A permission counts as "broad" only when it grants more than a specific
// scoped target. Scoped forms like `WebFetch(domain:example.com)` and
// `mcp__github__get_issue` are narrow — the previous heuristic flagged
// both as broad, which produced false positives on every PR that scoped
// its grants properly. Bare tokens and explicit wildcards are still broad.
export function isBroadAllow(permission) {
    const normalized = permission.toLowerCase();
    if (/\bbash\([^)]*\*[^)]*\)/.test(normalized)) {
        return true;
    }
    if (/\b(read|write|edit)\((~|[a-z]:\\|\/|\*\*)/.test(normalized)) {
        return true;
    }
    if (isBroadVerbGrant(normalized, ['webfetch', 'websearch', 'task'])) {
        return true;
    }
    if (isBroadMcpGrant(normalized)) {
        return true;
    }
    return false;
}
function isBroadVerbGrant(normalized, verbs) {
    for (const verb of verbs) {
        const pattern = new RegExp(`\\b${verb}\\b(\\([^)]*\\))?`);
        const match = pattern.exec(normalized);
        if (!match) {
            continue;
        }
        const scope = match[1] ?? '';
        if (scope === '' || scope.includes('*')) {
            return true;
        }
    }
    return false;
}
function isBroadMcpGrant(normalized) {
    // Claude Code MCP grants follow `mcp__<server>__<tool>`. A grant of just
    // `mcp__<server>` means every tool from that server; `mcp__<server>__*`
    // is the same thing spelled out. Anything narrower (a real tool name like
    // `get_issue`) is a specific grant and should not count as broad.
    //
    // Tool names contain underscores (`get_issue`, `create_pull_request`), so
    // we have to split on the literal `__` separator rather than a character
    // class — otherwise greedy matching collapses tool names into the server.
    const start = normalized.indexOf('mcp__');
    if (start === -1) {
        return false;
    }
    if (start > 0 && /[a-z0-9_]/.test(normalized[start - 1])) {
        return false;
    }
    const rest = normalized.slice(start + 'mcp__'.length);
    const grant = rest.match(/^[a-z0-9_*-]+/)?.[0] ?? '';
    if (!grant) {
        return true;
    }
    const parts = grant.split('__');
    const server = parts[0];
    const tool = parts.length > 1 ? parts.slice(1).join('__') : undefined;
    if (!server || server.includes('*')) {
        return true;
    }
    return !tool || tool.includes('*');
}
export function isSensitiveDeny(permission) {
    const normalized = permission.toLowerCase();
    return normalized.includes('.env')
        || normalized.includes('secret')
        || normalized.includes('credential')
        || normalized.includes('.pem');
}
function readStringArray(value) {
    return Array.isArray(value) ? value.filter((entry) => typeof entry === 'string') : [];
}
function readStringArrayWithLines(value, sourceText) {
    return new Map(readStringArray(value).map((entry) => [entry, lineOfJsonStringValue(sourceText, entry)]));
}
function hookHasEntries(value) {
    if (Array.isArray(value)) {
        return value.length > 0;
    }
    return isRecord(value) && Object.keys(value).length > 0;
}
