import { normalizeMcpCommand } from 'agent-gov-core';
import { configPath, isRecord, lineOfJsonKey, readJsonObjectWithSource } from '../discovery.js';
import { configParseFinding } from './errors.js';
const MCP_CONFIGS = [
    { surfaceId: 'root_mcp', path: '.mcp.json', serverKeys: ['mcpServers'] },
    { surfaceId: 'cursor_mcp', path: '.cursor/mcp.json', serverKeys: ['mcpServers', 'servers'] },
    { surfaceId: 'vscode_mcp', path: '.vscode/mcp.json', serverKeys: ['servers', 'mcpServers'] },
    { surfaceId: 'codeium_mcp', path: '.codeium/mcp_config.json', serverKeys: ['mcpServers'] },
    { surfaceId: 'windsurf_mcp', path: '.codeium/windsurf/mcp_config.json', serverKeys: ['mcpServers'] }
];
export async function parseMcpSurfaces(root) {
    const surfaces = [];
    const findings = [];
    for (const config of MCP_CONFIGS) {
        const { servers, configured, finding } = await readMcpServers(root, config);
        if (finding) {
            findings.push(finding);
        }
        if (configured) {
            surfaces.push({
                surfaceId: config.surfaceId,
                file: config.path,
                servers
            });
        }
    }
    return { surfaces, findings };
}
async function readMcpServers(root, config) {
    const source = await readJsonObjectWithSource(configPath(root, config.path));
    if (!source.text.trim()) {
        return { servers: [], configured: false };
    }
    if (source.parseError) {
        return {
            servers: [],
            configured: false,
            finding: configParseFinding(config.path, config.surfaceId, source.parseError)
        };
    }
    const rawServers = readServerMap(source.json, config.serverKeys);
    if (!isRecord(rawServers)) {
        return { servers: [], configured: false };
    }
    const servers = [];
    for (const [name, value] of Object.entries(rawServers)) {
        if (!isRecord(value)) {
            continue;
        }
        const raw = {
            line: lineOfJsonKey(source.text, name),
            sourceText: source.text,
            command: typeof value.command === 'string' ? value.command : undefined,
            args: Array.isArray(value.args) ? value.args.filter((arg) => typeof arg === 'string') : undefined,
            enabled: typeof value.enabled === 'boolean' ? value.enabled : undefined,
            disabled: typeof value.disabled === 'boolean' ? value.disabled : undefined,
            env: readStringMap(value.env),
            headers: readStringMap(value.headers),
            url: typeof value.url === 'string' ? value.url : undefined,
            serverUrl: typeof value.serverUrl === 'string' ? value.serverUrl : undefined
        };
        const command = serverCommand(raw);
        if (!command) {
            continue;
        }
        servers.push({
            name,
            command,
            rawCommand: raw.command,
            canonicalIdentity: normalizeMcpCommand({
                command: raw.command,
                args: raw.args,
                url: raw.url ?? raw.serverUrl,
            }),
            enabled: serverEnabled(raw),
            env: raw.env ?? {},
            headers: raw.headers ?? {},
            args: raw.args,
            unpinned: isUnpinnedCommand(raw),
            line: raw.line,
            file: config.path,
            surfaceId: config.surfaceId
        });
    }
    return { servers, configured: true };
}
function readServerMap(json, serverKeys) {
    for (const key of serverKeys) {
        if (isRecord(json[key])) {
            return json[key];
        }
    }
    return undefined;
}
function readStringMap(value) {
    if (!isRecord(value)) {
        return undefined;
    }
    const entries = Object.entries(value).filter((entry) => typeof entry[1] === 'string');
    return Object.fromEntries(entries);
}
export function serverCommand(server) {
    return [server.command, ...(server.args ?? []), server.url, server.serverUrl].filter(Boolean).join(' ');
}
function serverEnabled(server) {
    if (server.disabled !== undefined) {
        return !server.disabled;
    }
    return server.enabled !== false;
}
export function isUnpinnedCommand(server) {
    const command = serverCommand(server);
    const normalized = command.toLowerCase();
    if (normalized.includes('@latest')) {
        return true;
    }
    const githubUrl = normalized.match(/https:\/\/github\.com\/[^ ]+/);
    if (githubUrl) {
        // A GitHub URL is unpinned UNLESS it references an immutable 40-char
        // commit SHA (e.g. .../archive/<sha>.tar.gz, .../tree/<sha>, or
        // git+https://...#<sha>). Branch / tag / HEAD references are mutable
        // and stay flagged. This avoids over-flagging every GitHub URL as
        // unpinned when a SHA already makes the install reproducible.
        if (!/[0-9a-f]{40}/.test(githubUrl[0])) {
            return true;
        }
    }
    if (/\bcurl\b.+\|\s*(bash|sh)\b/.test(normalized)) {
        return true;
    }
    if (/\b(iwr|invoke-webrequest)\b.+\|\s*(iex|invoke-expression)\b/.test(normalized)) {
        return true;
    }
    const packageLikeArgs = server.args ?? [];
    return ['npx', 'uvx', 'pipx'].includes((server.command ?? '').toLowerCase())
        && packageLikeArgs.some((arg) => looksLikePackageName(arg) && !hasExactVersion(arg));
}
function looksLikePackageName(value) {
    return /^[a-z0-9@][a-z0-9._/@-]+$/i.test(value) && !value.startsWith('-');
}
function hasExactVersion(value) {
    const packageVersion = value.startsWith('@') ? value.indexOf('@', 1) : value.indexOf('@');
    if (packageVersion === -1) {
        return false;
    }
    const version = value.slice(packageVersion + 1);
    return /^\d+\.\d+\.\d+/.test(version);
}
