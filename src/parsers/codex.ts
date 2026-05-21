import { readFile } from 'node:fs/promises';
import { configPath } from '../discovery.js';
import type { CodexPolicy } from '../types.js';

const CODEX_CONFIG_FILE = '.codex/config.toml';

export async function parseCodexPolicy(root: string): Promise<CodexPolicy | undefined> {
  let text = '';
  try {
    text = await readFile(configPath(root, CODEX_CONFIG_FILE), 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  }

  if (!text.trim()) {
    return undefined;
  }

  const entries = parseTomlEntries(text);
  const sandbox = entries.get('sandbox_mode') ?? entries.get('sandbox') ?? entries.get('windows.sandbox');
  const approval = entries.get('approval_policy');
  const network = entries.get('network_access') ?? entries.get('sandbox_workspace_write.network_access');
  const trust = entries.get('projects.trust_level');

  if (!sandbox && !approval && !network && !trust) {
    return undefined;
  }

  return {
    surfaceId: 'codex',
    file: CODEX_CONFIG_FILE,
    sandbox: sandbox?.value,
    sandboxLine: sandbox?.line,
    approvalPolicy: approval?.value,
    networkAccess: network?.value === 'true',
    networkLine: network?.line,
    trusted: trust?.value === 'trusted',
    trustLine: trust?.line
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

function parseTomlEntries(text: string): Map<string, TomlEntry> {
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

    const keyMatch = /^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/.exec(trimmed);
    if (!keyMatch) {
      continue;
    }

    const key = normalizeKey(section, keyMatch[1]);
    const value = parseScalarValue(keyMatch[2]);
    if (value !== undefined) {
      entries.set(key, { line: index + 1, value });
    }
  }

  return entries;
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
