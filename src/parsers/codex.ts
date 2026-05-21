import { readFile } from 'node:fs/promises';
import { configPath } from '../discovery.js';
import { configParseFinding } from './errors.js';
import type { JsonParseError } from '../discovery.js';
import type { CodexPolicy, Finding } from '../types.js';

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

  if (!sandbox && !approval && !network && !trust) {
    return { findings: [] };
  }

  return {
    policy: {
      surfaceId: 'codex',
      file: CODEX_CONFIG_FILE,
      sandbox: sandbox?.value,
      sandboxLine: sandbox?.line,
      approvalPolicy: approval?.value,
      networkAccess: network?.value === 'true',
      networkLine: network?.line,
      trusted: trust?.value === 'trusted',
      trustLine: trust?.line
    },
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
  parseError?: JsonParseError;
}

function parseTomlEntries(text: string): TomlParseResult {
  const entries = new Map<string, TomlEntry>();
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
      section = normalizeSection(sectionMatch[1]);
      continue;
    }

    if (trimmed.startsWith('[')) {
      return {
        entries,
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
          parseError: {
            message: `Invalid TOML assignment for "${malformedKey}"; expected key = value`,
            line: index + 1
          }
        };
      }
      continue;
    }

    const key = normalizeKey(section, keyMatch[1]);
    const value = parseScalarValue(keyMatch[2]);
    if (value !== undefined) {
      entries.set(key, { line: index + 1, value });
    } else if (WATCHED_CODEX_KEYS.has(key)) {
      return {
        entries,
        parseError: {
          message: `Invalid TOML scalar value for "${key}"`,
          line: index + 1
        }
      };
    }
  }

  return { entries };
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

function findMalformedWatchedKey(section: string, trimmed: string): string | undefined {
  const token = /^([A-Za-z0-9_.-]+)/.exec(trimmed)?.[1];
  if (!token) {
    return undefined;
  }

  const key = normalizeKey(section, token);
  return WATCHED_CODEX_KEYS.has(key) ? key : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
