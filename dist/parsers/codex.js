import { readFile } from 'node:fs/promises';
import { normalizeMcpCommand } from 'agent-gov-core';
import { configPath } from '../discovery.js';
import { isUnpinnedCommand, serverCommand } from './mcp.js';
import { configParseFinding } from './errors.js';
const CODEX_CONFIG_FILE = '.codex/config.toml';
const WATCHED_CODEX_KEYS = new Set([
    'sandbox_mode',
    'sandbox',
    'windows.sandbox',
    'approval_policy',
    'network_access',
    'sandbox_workspace_write.network_access',
    'projects.trust_level'
]);
export async function parseCodexPolicy(root) {
    let text = '';
    try {
        text = await readFile(configPath(root, CODEX_CONFIG_FILE), 'utf8');
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
            return { findings: [] };
        }
        throw error;
    }
    if (!text.trim()) {
        return { findings: [] };
    }
    const parsed = parseTomlEntries(text);
    if (parsed.parseError) {
        return {
            findings: [configParseFinding(CODEX_CONFIG_FILE, 'codex', parsed.parseError)]
        };
    }
    const entries = parsed.entries;
    const sandbox = entries.get('sandbox_mode') ?? entries.get('sandbox') ?? entries.get('windows.sandbox');
    const approval = entries.get('approval_policy');
    const network = entries.get('network_access') ?? entries.get('sandbox_workspace_write.network_access');
    const trust = entries.get('projects.trust_level');
    const hasPolicySettings = Boolean(sandbox || approval || network || trust);
    const mcpSurface = parsed.mcpServers.length > 0
        ? {
            surfaceId: 'codex',
            file: CODEX_CONFIG_FILE,
            servers: parsed.mcpServers
        }
        : undefined;
    if (!hasPolicySettings && !mcpSurface) {
        return { findings: [] };
    }
    return {
        policy: hasPolicySettings
            ? {
                surfaceId: 'codex',
                file: CODEX_CONFIG_FILE,
                sandbox: sandbox?.value,
                sandboxLine: sandbox?.line,
                approvalPolicy: approval?.value,
                networkAccess: network?.value === 'true',
                networkLine: network?.line,
                trusted: trust?.value === 'trusted',
                trustLine: trust?.line
            }
            : undefined,
        mcpSurface,
        findings: []
    };
}
export function codexSandboxRank(value) {
    if (!value) {
        return -1;
    }
    if (['danger-full-access', 'danger_full_access', 'elevated'].includes(value)) {
        return 3;
    }
    if (['workspace-write', 'workspace_write'].includes(value)) {
        return 1;
    }
    if (['read-only', 'read_only'].includes(value)) {
        return 0;
    }
    return -1;
}
function parseTomlEntries(text) {
    const entries = new Map();
    const mcpDrafts = new Map();
    let section = '';
    const lines = joinMultilineValues(text.split(/\r?\n/));
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }
        const sectionMatch = /^\[([^\]]+)\]$/.exec(trimmed);
        if (sectionMatch) {
            section = sectionMatch[1].trim();
            const mcpSection = parseMcpServerSection(section);
            if (mcpSection) {
                getMcpDraft(mcpDrafts, mcpSection.name, index + 1);
            }
            continue;
        }
        if (trimmed.startsWith('[')) {
            return {
                entries,
                mcpServers: buildCodexMcpServers(mcpDrafts),
                parseError: {
                    message: 'Invalid TOML section header',
                    line: index + 1
                }
            };
        }
        const keyMatch = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(trimmed);
        if (!keyMatch) {
            const malformedKey = findMalformedWatchedKey(section, trimmed);
            if (malformedKey) {
                return {
                    entries,
                    mcpServers: buildCodexMcpServers(mcpDrafts),
                    parseError: {
                        message: `Invalid TOML assignment for "${malformedKey}"; expected key = value`,
                        line: index + 1
                    }
                };
            }
            continue;
        }
        const mcpSection = parseMcpServerSection(section);
        if (mcpSection) {
            recordMcpServerValue(mcpDrafts, mcpSection, keyMatch[1], keyMatch[2], index + 1);
            continue;
        }
        const key = normalizeKey(normalizeSection(section), keyMatch[1]);
        const value = parseScalarValue(keyMatch[2]);
        if (value !== undefined) {
            entries.set(key, { line: index + 1, value });
        }
        else if (WATCHED_CODEX_KEYS.has(key)) {
            return {
                entries,
                mcpServers: buildCodexMcpServers(mcpDrafts),
                parseError: {
                    message: `Invalid TOML scalar value for "${key}"`,
                    line: index + 1
                }
            };
        }
    }
    return { entries, mcpServers: buildCodexMcpServers(mcpDrafts) };
}
/**
 * Pre-pass that collapses multi-line array and inline-table values onto
 * their opening line so the line-oriented parser below sees a single
 * logical assignment. Continuation lines are zeroed out so subsequent
 * line numbers and section detection remain accurate.
 *
 * Real-world Codex configs frequently write `args = [\n  "-y",\n  "x"\n]`
 * across multiple lines; before this pass, only the opening `[` reached
 * `parseStringArrayValue`, which produced silent args loss and downstream
 * mcp_command_mismatch false positives against the joined MCP surfaces.
 */
function joinMultilineValues(lines) {
    const result = [...lines];
    for (let index = 0; index < result.length; index += 1) {
        const line = result[index];
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) {
            continue;
        }
        const keyMatch = /^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/.exec(trimmed);
        if (!keyMatch) {
            continue;
        }
        const initialBalance = scanValueBalance(keyMatch[2]);
        if (initialBalance.bracketDepth === 0 && initialBalance.braceDepth === 0) {
            continue;
        }
        let buffer = line;
        let bracketDepth = initialBalance.bracketDepth;
        let braceDepth = initialBalance.braceDepth;
        let cursor = index + 1;
        while ((bracketDepth > 0 || braceDepth > 0) && cursor < result.length) {
            const cont = result[cursor];
            buffer += ' ' + cont.trim();
            const contBalance = scanValueBalance(cont);
            bracketDepth += contBalance.bracketDepth;
            braceDepth += contBalance.braceDepth;
            result[cursor] = '';
            cursor += 1;
        }
        result[index] = buffer;
        index = cursor - 1;
    }
    return result;
}
function scanValueBalance(value) {
    let bracketDepth = 0;
    let braceDepth = 0;
    let quote;
    let escape = false;
    for (let i = 0; i < value.length; i += 1) {
        const char = value[i];
        if (quote) {
            if (escape) {
                escape = false;
                continue;
            }
            if (char === '\\' && quote === '"') {
                escape = true;
                continue;
            }
            if (char === quote) {
                quote = undefined;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        // A '#' outside any quote begins a comment; the rest of the line
        // (or buffer) is not part of the value balance.
        if (char === '#') {
            break;
        }
        if (char === '[') {
            bracketDepth += 1;
        }
        else if (char === ']') {
            bracketDepth -= 1;
        }
        else if (char === '{') {
            braceDepth += 1;
        }
        else if (char === '}') {
            braceDepth -= 1;
        }
    }
    return { bracketDepth, braceDepth };
}
function normalizeSection(section) {
    const normalized = section.trim().toLowerCase();
    return normalized.startsWith('projects.') ? 'projects' : normalized;
}
function normalizeKey(section, key) {
    const normalizedKey = key.trim().toLowerCase();
    return section ? `${section}.${normalizedKey}` : normalizedKey;
}
function parseScalarValue(rawValue) {
    const trimmed = rawValue.trim();
    const stringMatch = /^"([^"]*)"/.exec(trimmed) ?? /^'([^']*)'/.exec(trimmed);
    if (stringMatch) {
        return stringMatch[1].toLowerCase();
    }
    const bareMatch = /^(true|false|[A-Za-z0-9_.-]+)/.exec(trimmed);
    return bareMatch?.[1].toLowerCase();
}
function parseMcpServerSection(section) {
    const parts = splitTomlPath(section);
    if (parts[0] !== 'mcp_servers' || !parts[1]) {
        return undefined;
    }
    if (parts.length === 2) {
        return { name: parts[1] };
    }
    if (parts.length === 3 && isCodexMcpSubtable(parts[2])) {
        return { name: parts[1], subtable: parts[2] };
    }
    return undefined;
}
function splitTomlPath(path) {
    const parts = [];
    let current = '';
    let quote;
    let escape = false;
    for (const char of path.trim()) {
        if (quote) {
            if (escape) {
                current += char;
                escape = false;
            }
            else if (char === '\\' && quote === '"') {
                escape = true;
            }
            else if (char === quote) {
                quote = undefined;
            }
            else {
                current += char;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === '.') {
            parts.push(current.trim());
            current = '';
            continue;
        }
        current += char;
    }
    parts.push(current.trim());
    return parts.filter((part) => part.length > 0);
}
function isCodexMcpSubtable(value) {
    return value === 'env' || value === 'http_headers' || value === 'env_http_headers';
}
function getMcpDraft(drafts, name, line) {
    const existing = drafts.get(name);
    if (existing) {
        return existing;
    }
    const draft = {
        line,
        env: {},
        headers: {}
    };
    drafts.set(name, draft);
    return draft;
}
function recordMcpServerValue(drafts, section, rawKey, rawValue, line) {
    const key = rawKey.trim().toLowerCase();
    const draft = getMcpDraft(drafts, section.name, line);
    if (section.subtable === 'env') {
        const value = parseStringValue(rawValue);
        if (value !== undefined) {
            draft.env[rawKey.trim()] = value;
        }
        return;
    }
    if (section.subtable === 'http_headers' || section.subtable === 'env_http_headers') {
        const value = parseStringValue(rawValue);
        if (value !== undefined) {
            draft.headers[rawKey.trim()] = section.subtable === 'env_http_headers' ? `env:${value}` : value;
        }
        return;
    }
    if (key === 'command') {
        draft.command = parseStringValue(rawValue);
    }
    else if (key === 'args') {
        draft.args = parseStringArrayValue(rawValue);
    }
    else if (key === 'url') {
        draft.url = parseStringValue(rawValue);
    }
    else if (key === 'server_url' || key === 'serverurl') {
        draft.serverUrl = parseStringValue(rawValue);
    }
    else if (key === 'enabled') {
        draft.enabled = parseBooleanValue(rawValue);
    }
    else if (key === 'env') {
        draft.env = { ...draft.env, ...parseStringMapValue(rawValue, false) };
    }
    else if (key === 'http_headers') {
        draft.headers = { ...draft.headers, ...parseStringMapValue(rawValue, false) };
    }
    else if (key === 'env_http_headers') {
        draft.headers = { ...draft.headers, ...parseStringMapValue(rawValue, true) };
    }
    else if (key === 'bearer_token_env_var') {
        const value = parseStringValue(rawValue);
        if (value !== undefined) {
            draft.headers.Authorization = `env:${value}`;
        }
    }
}
function buildCodexMcpServers(drafts) {
    const servers = [];
    for (const [name, draft] of drafts) {
        const command = serverCommand(draft);
        if (!command) {
            continue;
        }
        servers.push({
            name,
            command,
            canonicalIdentity: normalizeMcpCommand({
                command: draft.command,
                args: draft.args,
                url: draft.url ?? draft.serverUrl,
            }),
            enabled: draft.enabled !== false,
            env: draft.env,
            headers: draft.headers,
            args: draft.args,
            unpinned: isUnpinnedCommand(draft),
            line: draft.line,
            file: CODEX_CONFIG_FILE,
            surfaceId: 'codex'
        });
    }
    return servers;
}
function parseStringValue(rawValue) {
    const trimmed = stripTomlInlineComment(rawValue).trim();
    const doubleQuoted = /^"((?:\\.|[^"])*)"/.exec(trimmed);
    if (doubleQuoted) {
        return decodeTomlDoubleQuotedString(doubleQuoted[1]);
    }
    const singleQuoted = /^'([^']*)'/.exec(trimmed);
    if (singleQuoted) {
        return singleQuoted[1];
    }
    return /^([^,\]}#\s]+)/.exec(trimmed)?.[1];
}
function parseStringArrayValue(rawValue) {
    const trimmed = stripTomlInlineComment(rawValue).trim();
    if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
        return undefined;
    }
    const entries = splitTomlList(trimmed.slice(1, -1))
        .map((entry) => parseStringValue(entry))
        .filter((entry) => entry !== undefined);
    return entries;
}
function parseStringMapValue(rawValue, envBacked) {
    const trimmed = stripTomlInlineComment(rawValue).trim();
    if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
        return {};
    }
    const map = {};
    for (const entry of splitTomlList(trimmed.slice(1, -1))) {
        const [rawKey, rawEntryValue] = splitTomlAssignment(entry);
        const key = parseMapKey(rawKey);
        const value = parseStringValue(rawEntryValue ?? '');
        if (key && value !== undefined) {
            map[key] = envBacked ? `env:${value}` : value;
        }
    }
    return map;
}
function parseMapKey(rawKey) {
    if (!rawKey) {
        return undefined;
    }
    return parseStringValue(rawKey) ?? rawKey.trim();
}
function parseBooleanValue(rawValue) {
    const value = stripTomlInlineComment(rawValue).trim().toLowerCase();
    if (value.startsWith('true')) {
        return true;
    }
    if (value.startsWith('false')) {
        return false;
    }
    return undefined;
}
function splitTomlAssignment(entry) {
    let quote;
    let escape = false;
    for (let index = 0; index < entry.length; index += 1) {
        const char = entry[index];
        if (quote) {
            if (escape) {
                escape = false;
            }
            else if (char === '\\' && quote === '"') {
                escape = true;
            }
            else if (char === quote) {
                quote = undefined;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === '=') {
            return [entry.slice(0, index), entry.slice(index + 1)];
        }
    }
    return [entry, undefined];
}
function splitTomlList(value) {
    const entries = [];
    let current = '';
    let quote;
    let escape = false;
    let braceDepth = 0;
    let bracketDepth = 0;
    for (const char of value) {
        if (quote) {
            current += char;
            if (escape) {
                escape = false;
            }
            else if (char === '\\' && quote === '"') {
                escape = true;
            }
            else if (char === quote) {
                quote = undefined;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            current += char;
            continue;
        }
        if (char === '{') {
            braceDepth += 1;
        }
        else if (char === '}') {
            braceDepth -= 1;
        }
        else if (char === '[') {
            bracketDepth += 1;
        }
        else if (char === ']') {
            bracketDepth -= 1;
        }
        if (char === ',' && braceDepth === 0 && bracketDepth === 0) {
            entries.push(current.trim());
            current = '';
            continue;
        }
        current += char;
    }
    if (current.trim()) {
        entries.push(current.trim());
    }
    return entries;
}
function stripTomlInlineComment(rawValue) {
    let quote;
    let escape = false;
    for (let index = 0; index < rawValue.length; index += 1) {
        const char = rawValue[index];
        if (quote) {
            if (escape) {
                escape = false;
            }
            else if (char === '\\' && quote === '"') {
                escape = true;
            }
            else if (char === quote) {
                quote = undefined;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === '#') {
            return rawValue.slice(0, index);
        }
    }
    return rawValue;
}
function decodeTomlDoubleQuotedString(value) {
    return value.replace(/\\(["\\bfnrt])/g, (_match, escaped) => {
        if (escaped === 'b') {
            return '\b';
        }
        if (escaped === 'f') {
            return '\f';
        }
        if (escaped === 'n') {
            return '\n';
        }
        if (escaped === 'r') {
            return '\r';
        }
        if (escaped === 't') {
            return '\t';
        }
        return escaped;
    });
}
function findMalformedWatchedKey(section, trimmed) {
    const token = /^([A-Za-z0-9_.-]+)/.exec(trimmed)?.[1];
    if (!token) {
        return undefined;
    }
    const key = normalizeKey(normalizeSection(section), token);
    return WATCHED_CODEX_KEYS.has(key) ? key : undefined;
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
