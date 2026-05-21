import { configPath, isRecord, lineOfJsonStringValue, readJsonObjectWithSource } from '../discovery.js';
import type { ClaudePolicy } from '../types.js';

const CLAUDE_SETTINGS_FILE = '.claude/settings.json';

export async function parseClaudePolicy(root: string): Promise<ClaudePolicy | undefined> {
  const source = await readJsonObjectWithSource(configPath(root, CLAUDE_SETTINGS_FILE));
  if (!source.text.trim()) {
    return undefined;
  }

  const json = source.json;
  const permissions = isRecord(json.permissions) ? json.permissions : {};
  const hooks = isRecord(json.hooks) ? json.hooks : {};

  const allow = readStringArrayWithLines(permissions.allow, source.text);
  const deny = readStringArrayWithLines(permissions.deny, source.text);
  const hookNames = new Set(
    Object.entries(hooks)
      .filter(([, value]) => hookHasEntries(value))
      .map(([name]) => name)
  );

  if (allow.size === 0 && deny.size === 0 && hookNames.size === 0) {
    return undefined;
  }

  return {
    surfaceId: 'claude',
    file: CLAUDE_SETTINGS_FILE,
    allow,
    deny,
    hooks: hookNames
  };
}

export function isBroadAllow(permission: string): boolean {
  const normalized = permission.toLowerCase();

  return /\bbash\([^)]*\*[^)]*\)/.test(normalized)
    || /\bread\((~|[a-z]:\\|\/|\*\*)/.test(normalized)
    || /\b(write|edit)\((~|[a-z]:\\|\/|\*\*)/.test(normalized)
    || /\b(webfetch|websearch|mcp__|task)\(/.test(normalized);
}

export function isSensitiveDeny(permission: string): boolean {
  const normalized = permission.toLowerCase();
  return normalized.includes('.env')
    || normalized.includes('secret')
    || normalized.includes('credential')
    || normalized.includes('.pem');
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function readStringArrayWithLines(value: unknown, sourceText: string): Map<string, number | undefined> {
  return new Map(readStringArray(value).map((entry) => [entry, lineOfJsonStringValue(sourceText, entry)]));
}

function hookHasEntries(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }

  return isRecord(value) && Object.keys(value).length > 0;
}
