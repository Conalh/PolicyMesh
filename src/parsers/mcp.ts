import { configPath, isRecord, lineOfJsonKey, readJsonObjectWithSource } from '../discovery.js';
import type { McpServer, McpSurface, SurfaceId } from '../types.js';

const MCP_CONFIGS = [
  { surfaceId: 'root_mcp' as const, path: '.mcp.json', serverKeys: ['mcpServers'] },
  { surfaceId: 'cursor_mcp' as const, path: '.cursor/mcp.json', serverKeys: ['mcpServers', 'servers'] },
  { surfaceId: 'vscode_mcp' as const, path: '.vscode/mcp.json', serverKeys: ['servers', 'mcpServers'] },
  { surfaceId: 'windsurf_mcp' as const, path: '.codeium/windsurf/mcp_config.json', serverKeys: ['mcpServers'] }
] as const;

interface McpServerRaw {
  line?: number;
  sourceText?: string;
  command?: string;
  args?: string[];
  url?: string;
  serverUrl?: string;
}

export async function parseMcpSurfaces(root: string): Promise<McpSurface[]> {
  const surfaces: McpSurface[] = [];

  for (const config of MCP_CONFIGS) {
    const servers = await readMcpServers(root, config);
    if (servers.length > 0) {
      surfaces.push({
        surfaceId: config.surfaceId,
        file: config.path,
        servers
      });
    }
  }

  return surfaces;
}

async function readMcpServers(
  root: string,
  config: { surfaceId: SurfaceId; path: string; serverKeys: readonly string[] }
): Promise<McpServer[]> {
  const source = await readJsonObjectWithSource(configPath(root, config.path));
  if (!source.text.trim()) {
    return [];
  }

  const rawServers = readServerMap(source.json, config.serverKeys);
  if (!isRecord(rawServers)) {
    return [];
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
      unpinned: isUnpinnedCommand(raw),
      line: raw.line,
      file: config.path,
      surfaceId: config.surfaceId
    });
  }

  return servers;
}

function readServerMap(json: Record<string, unknown>, serverKeys: readonly string[]): unknown {
  for (const key of serverKeys) {
    if (isRecord(json[key])) {
      return json[key];
    }
  }

  return undefined;
}

export function serverCommand(server: McpServerRaw): string {
  return [server.command, ...(server.args ?? []), server.url, server.serverUrl].filter(Boolean).join(' ');
}

export function isUnpinnedCommand(server: McpServerRaw): boolean {
  const command = serverCommand(server);
  const normalized = command.toLowerCase();

  if (normalized.includes('@latest')) {
    return true;
  }

  if (/https:\/\/github\.com\/[^ ]+/.test(normalized)) {
    return true;
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
