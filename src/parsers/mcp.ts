import { normalizeMcpCommand } from 'agent-gov-core';
import { configPath, isRecord, lineOfJsonKey, readJsonObjectWithSource } from '../discovery.js';
import { configParseFinding } from './errors.js';
import type { Finding, McpServer, McpSurface, SurfaceId } from '../types.js';

const MCP_CONFIGS = [
  { surfaceId: 'root_mcp' as const, path: '.mcp.json', serverKeys: ['mcpServers'] },
  { surfaceId: 'cursor_mcp' as const, path: '.cursor/mcp.json', serverKeys: ['mcpServers', 'servers'] },
  { surfaceId: 'vscode_mcp' as const, path: '.vscode/mcp.json', serverKeys: ['servers', 'mcpServers'] },
  { surfaceId: 'codeium_mcp' as const, path: '.codeium/mcp_config.json', serverKeys: ['mcpServers'] },
  { surfaceId: 'windsurf_mcp' as const, path: '.codeium/windsurf/mcp_config.json', serverKeys: ['mcpServers'] }
] as const;

export interface McpServerRaw {
  line?: number;
  sourceText?: string;
  command?: string;
  args?: string[];
  enabled?: boolean;
  disabled?: boolean;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  url?: string;
  serverUrl?: string;
}

interface McpParseResult {
  surfaces: McpSurface[];
  findings: Finding[];
}

interface McpServersReadResult {
  servers: McpServer[];
  configured: boolean;
  finding?: Finding;
}

export async function parseMcpSurfaces(root: string): Promise<McpParseResult> {
  const surfaces: McpSurface[] = [];
  const findings: Finding[] = [];

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

async function readMcpServers(
  root: string,
  config: { surfaceId: SurfaceId; path: string; serverKeys: readonly string[] }
): Promise<McpServersReadResult> {
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

  const servers: McpServer[] = [];
  for (const [name, value] of Object.entries(rawServers)) {
    if (!isRecord(value)) {
      continue;
    }

    const raw: McpServerRaw = {
      line: lineOfJsonKey(source.text, name),
      sourceText: source.text,
      command: typeof value.command === 'string' ? value.command : undefined,
      args: Array.isArray(value.args) ? value.args.filter((arg): arg is string => typeof arg === 'string') : undefined,
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

function readServerMap(json: Record<string, unknown>, serverKeys: readonly string[]): unknown {
  for (const key of serverKeys) {
    if (isRecord(json[key])) {
      return json[key];
    }
  }

  return undefined;
}

function readStringMap(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }

  const entries = Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string');
  return Object.fromEntries(entries);
}

export function serverCommand(server: McpServerRaw): string {
  return [server.command, ...(server.args ?? []), server.url, server.serverUrl].filter(Boolean).join(' ');
}

function serverEnabled(server: McpServerRaw): boolean {
  if (server.disabled !== undefined) {
    return !server.disabled;
  }
  return server.enabled !== false;
}

export function isUnpinnedCommand(server: McpServerRaw): boolean {
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

function looksLikePackageName(value: string): boolean {
  return /^[a-z0-9@][a-z0-9._/@-]+$/i.test(value) && !value.startsWith('-');
}

function hasExactVersion(value: string): boolean {
  const packageVersion = value.startsWith('@') ? value.indexOf('@', 1) : value.indexOf('@');
  if (packageVersion === -1) {
    return false;
  }

  const version = value.slice(packageVersion + 1);
  return /^\d+\.\d+\.\d+/.test(version);
}
