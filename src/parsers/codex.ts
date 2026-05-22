import { readFile } from 'node:fs/promises';
import { normalizeMcpCommand } from 'agent-gov-core';
import { configPath } from '../discovery.js';
import { isUnpinnedCommand, serverCommand } from './mcp.js';
import { configParseFinding } from './errors.js';
import type { JsonParseError } from '../discovery.js';
import type { CodexPolicy, Finding, McpServer, McpSurface } from '../types.js';
import type { McpServerRaw } from './mcp.js';

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

interface CodexParseResult {
  policy?: CodexPolicy;
  mcpSurface?: McpSurface;
  findings: Finding[];
}

export async function parseCodexPolicy(root: string): Promise<CodexParseResult> {
  let text = '';
  try {
    text = await readFile(configPath(root, CODEX_CONFIG_FILE), 'utf8');
  } catch (error) {
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
        surfaceId: 'codex' as const,
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

export function codexSandboxRank(value: string | undefined): number {
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

interface TomlEntry {
  line: number;
  value: string;
}

interface TomlParseResult {
  entries: Map<string, TomlEntry>;
  mcpServers: McpServer[];
  parseError?: JsonParseError;
}

function parseTomlEntries(text: string): TomlParseResult {
  const entries = new Map<string, TomlEntry>();
  const mcpDrafts = new Map<string, CodexMcpServerDraft>();
  let section = '';

  const lines = text.split(/\r?\n/);
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
    } else if (WATCHED_CODEX_KEYS.has(key)) {
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

function normalizeSection(section: string): string {
  const normalized = section.trim().toLowerCase();
  return normalized.startsWith('projects.') ? 'projects' : normalized;
}

function normalizeKey(section: string, key: string): string {
  const normalizedKey = key.trim().toLowerCase();
  return section ? `${section}.${normalizedKey}` : normalizedKey;
}

function parseScalarValue(rawValue: string): string | undefined {
  const trimmed = rawValue.trim();
  const stringMatch = /^"([^"]*)"/.exec(trimmed) ?? /^'([^']*)'/.exec(trimmed);
  if (stringMatch) {
    return stringMatch[1].toLowerCase();
  }

  const bareMatch = /^(true|false|[A-Za-z0-9_.-]+)/.exec(trimmed);
  return bareMatch?.[1].toLowerCase();
}

type CodexMcpSubtable = 'env' | 'http_headers' | 'env_http_headers';

interface CodexMcpSection {
  name: string;
  subtable?: CodexMcpSubtable;
}

interface CodexMcpServerDraft extends McpServerRaw {
  line: number;
  env: Record<string, string>;
  headers: Record<string, string>;
}

function parseMcpServerSection(section: string): CodexMcpSection | undefined {
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

function splitTomlPath(path: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escape = false;

  for (const char of path.trim()) {
    if (quote) {
      if (escape) {
        current += char;
        escape = false;
      } else if (char === '\\' && quote === '"') {
        escape = true;
      } else if (char === quote) {
        quote = undefined;
      } else {
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

function isCodexMcpSubtable(value: string): value is CodexMcpSubtable {
  return value === 'env' || value === 'http_headers' || value === 'env_http_headers';
}

function getMcpDraft(
  drafts: Map<string, CodexMcpServerDraft>,
  name: string,
  line: number
): CodexMcpServerDraft {
  const existing = drafts.get(name);
  if (existing) {
    return existing;
  }

  const draft: CodexMcpServerDraft = {
    line,
    env: {},
    headers: {}
  };
  drafts.set(name, draft);
  return draft;
}

function recordMcpServerValue(
  drafts: Map<string, CodexMcpServerDraft>,
  section: CodexMcpSection,
  rawKey: string,
  rawValue: string,
  line: number
): void {
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
  } else if (key === 'args') {
    draft.args = parseStringArrayValue(rawValue);
  } else if (key === 'url') {
    draft.url = parseStringValue(rawValue);
  } else if (key === 'server_url' || key === 'serverurl') {
    draft.serverUrl = parseStringValue(rawValue);
  } else if (key === 'enabled') {
    draft.enabled = parseBooleanValue(rawValue);
  } else if (key === 'env') {
    draft.env = { ...draft.env, ...parseStringMapValue(rawValue, false) };
  } else if (key === 'http_headers') {
    draft.headers = { ...draft.headers, ...parseStringMapValue(rawValue, false) };
  } else if (key === 'env_http_headers') {
    draft.headers = { ...draft.headers, ...parseStringMapValue(rawValue, true) };
  } else if (key === 'bearer_token_env_var') {
    const value = parseStringValue(rawValue);
    if (value !== undefined) {
      draft.headers.Authorization = `env:${value}`;
    }
  }
}

function buildCodexMcpServers(drafts: Map<string, CodexMcpServerDraft>): McpServer[] {
  const servers: McpServer[] = [];
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
      unpinned: isUnpinnedCommand(draft),
      line: draft.line,
      file: CODEX_CONFIG_FILE,
      surfaceId: 'codex'
    });
  }

  return servers;
}

function parseStringValue(rawValue: string): string | undefined {
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

function parseStringArrayValue(rawValue: string): string[] | undefined {
  const trimmed = stripTomlInlineComment(rawValue).trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    return undefined;
  }

  const entries = splitTomlList(trimmed.slice(1, -1))
    .map((entry) => parseStringValue(entry))
    .filter((entry): entry is string => entry !== undefined);

  return entries;
}

function parseStringMapValue(rawValue: string, envBacked: boolean): Record<string, string> {
  const trimmed = stripTomlInlineComment(rawValue).trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) {
    return {};
  }

  const map: Record<string, string> = {};
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

function parseMapKey(rawKey: string | undefined): string | undefined {
  if (!rawKey) {
    return undefined;
  }

  return parseStringValue(rawKey) ?? rawKey.trim();
}

function parseBooleanValue(rawValue: string): boolean | undefined {
  const value = stripTomlInlineComment(rawValue).trim().toLowerCase();
  if (value.startsWith('true')) {
    return true;
  }
  if (value.startsWith('false')) {
    return false;
  }
  return undefined;
}

function splitTomlAssignment(entry: string): [string, string | undefined] {
  let quote: '"' | "'" | undefined;
  let escape = false;

  for (let index = 0; index < entry.length; index += 1) {
    const char = entry[index];

    if (quote) {
      if (escape) {
        escape = false;
      } else if (char === '\\' && quote === '"') {
        escape = true;
      } else if (char === quote) {
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

function splitTomlList(value: string): string[] {
  const entries: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let escape = false;
  let braceDepth = 0;
  let bracketDepth = 0;

  for (const char of value) {
    if (quote) {
      current += char;
      if (escape) {
        escape = false;
      } else if (char === '\\' && quote === '"') {
        escape = true;
      } else if (char === quote) {
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
    } else if (char === '}') {
      braceDepth -= 1;
    } else if (char === '[') {
      bracketDepth += 1;
    } else if (char === ']') {
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

function stripTomlInlineComment(rawValue: string): string {
  let quote: '"' | "'" | undefined;
  let escape = false;

  for (let index = 0; index < rawValue.length; index += 1) {
    const char = rawValue[index];

    if (quote) {
      if (escape) {
        escape = false;
      } else if (char === '\\' && quote === '"') {
        escape = true;
      } else if (char === quote) {
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

function decodeTomlDoubleQuotedString(value: string): string {
  return value.replace(/\\(["\\bfnrt])/g, (_match, escaped: string) => {
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

function findMalformedWatchedKey(section: string, trimmed: string): string | undefined {
  const token = /^([A-Za-z0-9_.-]+)/.exec(trimmed)?.[1];
  if (!token) {
    return undefined;
  }

  const key = normalizeKey(normalizeSection(section), token);
  return WATCHED_CODEX_KEYS.has(key) ? key : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
