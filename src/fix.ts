import { readFile, writeFile } from 'node:fs/promises';
import { parseRepoPolicies } from './parsers/index.js';
import { configPath } from './discovery.js';
import type { McpServer, RepoPolicies, SurfaceId } from './types.js';

const JSON_MCP_SURFACES: SurfaceId[] = [
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
const PREFERRED_KEY: Record<SurfaceId, 'enabled' | 'disabled'> = {
  root_mcp: 'enabled',
  cursor_mcp: 'disabled',
  vscode_mcp: 'enabled',
  codeium_mcp: 'enabled',
  windsurf_mcp: 'enabled',
  claude: 'enabled',
  codex: 'enabled',
  aider: 'enabled'
};

export interface PlannedFix {
  file: string;
  surface: SurfaceId;
  server: string;
  before: boolean;
  after: boolean;
  description: string;
}

export interface FixPlan {
  canonical: SurfaceId;
  fixes: PlannedFix[];
  skipped: SkippedFinding[];
}

export interface SkippedFinding {
  kind: string;
  subject: string;
  reason: string;
}

export async function planEnabledStateFixes(root: string, canonical: SurfaceId): Promise<FixPlan> {
  if (!JSON_MCP_SURFACES.includes(canonical)) {
    throw new Error(`--canonical must be a JSON MCP surface in v1 (one of ${JSON_MCP_SURFACES.join(', ')}); got "${canonical}".`);
  }

  const policies = await parseRepoPolicies(root);
  const canonicalServers = serversBySurface(policies, canonical);
  const fixes: PlannedFix[] = [];

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

function serversBySurface(policies: RepoPolicies, surfaceId: SurfaceId): Map<string, McpServer> {
  const surface = policies.mcpSurfaces.find((entry) => entry.surfaceId === surfaceId);
  const map = new Map<string, McpServer>();
  if (!surface) {
    return map;
  }
  for (const server of surface.servers) {
    map.set(server.name, server);
  }
  return map;
}

export interface ApplyFixResult {
  applied: PlannedFix[];
  skipped: PlannedFix[];
}

export async function applyEnabledStateFixes(plan: FixPlan, root: string, write: boolean): Promise<ApplyFixResult> {
  const applied: PlannedFix[] = [];
  const skipped: PlannedFix[] = [];

  // Group fixes by file so we read/parse/write each config at most once.
  const byFile = new Map<string, PlannedFix[]>();
  for (const fix of plan.fixes) {
    const existing = byFile.get(fix.file) ?? [];
    existing.push(fix);
    byFile.set(fix.file, existing);
  }

  for (const [file, fileFixes] of byFile) {
    const fullPath = configPath(root, file);
    const raw = await readFile(fullPath, 'utf8');
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      for (const fix of fileFixes) {
        skipped.push(fix);
      }
      continue;
    }

    const serverMap = readServerMap(json);
    if (!serverMap) {
      for (const fix of fileFixes) {
        skipped.push(fix);
      }
      continue;
    }

    let mutated = false;
    for (const fix of fileFixes) {
      const server = serverMap[fix.server];
      if (!isRecord(server)) {
        skipped.push(fix);
        continue;
      }
      const keyChoice = chooseKey(server, fix.surface);
      if (keyChoice === 'enabled') {
        server.enabled = fix.after;
        delete server.disabled;
      } else {
        server.disabled = !fix.after;
        delete server.enabled;
      }
      mutated = true;
      applied.push(fix);
    }

    if (mutated && write) {
      await writeFile(fullPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
    }
  }

  return { applied, skipped };
}

function readServerMap(json: Record<string, unknown>): Record<string, unknown> | undefined {
  for (const key of ['mcpServers', 'servers']) {
    const value = json[key];
    if (isRecord(value)) {
      return value;
    }
  }
  return undefined;
}

function chooseKey(server: Record<string, unknown>, surface: SurfaceId): 'enabled' | 'disabled' {
  if ('enabled' in server && typeof server.enabled === 'boolean') {
    return 'enabled';
  }
  if ('disabled' in server && typeof server.disabled === 'boolean') {
    return 'disabled';
  }
  return PREFERRED_KEY[surface];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function formatFixPlan(plan: FixPlan, applied?: ApplyFixResult): string {
  const lines: string[] = [];
  lines.push(`PolicyMesh fix plan against canonical surface: ${plan.canonical}`);
  if (plan.fixes.length === 0) {
    lines.push('No mcp_enabled_mismatch findings to align.');
    return `${lines.join('\n')}\n`;
  }

  if (applied) {
    lines.push(`Applied ${applied.applied.length} edit(s), skipped ${applied.skipped.length}.`);
  } else {
    lines.push(`Would apply ${plan.fixes.length} edit(s). Re-run with --write to persist.`);
  }
  for (const fix of plan.fixes) {
    lines.push(`- ${fix.description}`);
  }
  if (applied && applied.skipped.length > 0) {
    lines.push('Skipped:');
    for (const fix of applied.skipped) {
      lines.push(`- ${fix.description} (server entry not found or unparseable)`);
    }
  }
  return `${lines.join('\n')}\n`;
}
