import { readFile, writeFile } from 'node:fs/promises';
import { stripJsonComments } from 'agent-gov-core';
import { parseRepoPolicies } from './parsers/index.js';
import { configPath, lineOfJsonKey } from './discovery.js';
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
  aider: 'enabled',
  instructions: 'enabled'
};

export interface PlannedFix {
  file: string;
  surface: SurfaceId;
  server: string;
  before: boolean;
  after: boolean;
  description: string;
}

export interface PlannedPinFix {
  file: string;
  surface: SurfaceId;
  server: string;
  canonicalCommand?: string;
  canonicalArgs?: string[];
  description: string;
}

export interface PinFixPlan {
  canonical: SurfaceId;
  fixes: PlannedPinFix[];
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
  skipped: SkippedApply[];
}

export interface SkippedApply {
  fix: PlannedFix;
  reason: string;
}

export interface ApplyPinResult {
  applied: PlannedPinFix[];
  skipped: { fix: PlannedPinFix; reason: string }[];
}

export async function planPinFixes(root: string, canonical: SurfaceId): Promise<PinFixPlan> {
  if (!JSON_MCP_SURFACES.includes(canonical)) {
    throw new Error(`--canonical must be a JSON MCP surface in v1 (one of ${JSON_MCP_SURFACES.join(', ')}); got "${canonical}".`);
  }

  const policies = await parseRepoPolicies(root);
  const canonicalServers = serversBySurface(policies, canonical);
  const fixes: PlannedPinFix[] = [];

  for (const surface of policies.mcpSurfaces) {
    if (surface.surfaceId === canonical || !JSON_MCP_SURFACES.includes(surface.surfaceId)) {
      continue;
    }
    for (const server of surface.servers) {
      const canonicalServer = canonicalServers.get(server.name);
      if (!canonicalServer) {
        continue;
      }
      // Only plan a fix when the canonical-identity normalisation
      // already says these diverge — neutral differences (-y flag,
      // .cmd suffix, flag reorder) are not worth rewriting.
      if (server.canonicalIdentity === canonicalServer.canonicalIdentity) {
        continue;
      }
      // Reproduce the canonical surface's *raw* shape, not the joined
      // display command. Splitting `command` on spaces dropped every
      // argument whenever the canonical config used a single inline
      // command string ("npx -y pkg@1.2.3"), silently rewriting the
      // target down to just "npx". `rawCommand` is the verbatim
      // `command` value; `args` is the verbatim args array (if any).
      if (canonicalServer.rawCommand === undefined && canonicalServer.args === undefined) {
        // Remote (url-only) server or otherwise nothing launchable to
        // copy — fix pin only aligns command/args.
        continue;
      }
      fixes.push({
        file: server.file,
        surface: server.surfaceId,
        server: server.name,
        canonicalCommand: canonicalServer.rawCommand,
        canonicalArgs: canonicalServer.args,
        description: `Align "${server.name}" command/args to ${canonical} in ${server.file}`
      });
    }
  }

  return { canonical, fixes };
}

export async function applyPinFixes(plan: PinFixPlan, root: string, write: boolean): Promise<ApplyPinResult> {
  const applied: PlannedPinFix[] = [];
  const skipped: { fix: PlannedPinFix; reason: string }[] = [];

  const byFile = new Map<string, PlannedPinFix[]>();
  for (const fix of plan.fixes) {
    const existing = byFile.get(fix.file) ?? [];
    existing.push(fix);
    byFile.set(fix.file, existing);
  }

  for (const [file, fileFixes] of byFile) {
    const fullPath = configPath(root, file);
    const originalText = await readFile(fullPath, 'utf8');
    const editor = new JsonLineEditor(originalText);

    for (const fix of fileFixes) {
      const result = editor.alignCommandAndArgs(fix.server, fix.canonicalCommand, fix.canonicalArgs);
      if (result.ok) {
        applied.push(fix);
      } else {
        skipped.push({ fix, reason: result.reason });
      }
    }

    if (editor.mutated() && write) {
      await writeFile(fullPath, editor.text(), 'utf8');
    }
  }

  return { applied, skipped };
}

export function formatPinPlan(plan: PinFixPlan, applied?: ApplyPinResult): string {
  const lines: string[] = [];
  lines.push(`PolicyMesh pin plan against canonical surface: ${plan.canonical}`);
  lines.push('Note: fix pin rewrites the command and args of MCP server entries — the very content PolicyMesh audits.');
  lines.push('Review every edit carefully; back up or commit before running with --write.');
  lines.push('');

  if (plan.fixes.length === 0) {
    lines.push('No command/args drift to align.');
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
    for (const skip of applied.skipped) {
      lines.push(`- ${skip.fix.description} (${skip.reason})`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export async function applyEnabledStateFixes(plan: FixPlan, root: string, write: boolean): Promise<ApplyFixResult> {
  const applied: PlannedFix[] = [];
  const skipped: SkippedApply[] = [];

  // Group fixes by file so we read/edit each config at most once.
  const byFile = new Map<string, PlannedFix[]>();
  for (const fix of plan.fixes) {
    const existing = byFile.get(fix.file) ?? [];
    existing.push(fix);
    byFile.set(fix.file, existing);
  }

  for (const [file, fileFixes] of byFile) {
    const fullPath = configPath(root, file);
    const originalText = await readFile(fullPath, 'utf8');
    const editor = new JsonLineEditor(originalText);

    for (const fix of fileFixes) {
      const result = editor.alignEnabledState(fix.server, fix.after, fix.surface);
      if (result.ok) {
        applied.push(fix);
      } else {
        skipped.push({ fix, reason: result.reason });
      }
    }

    if (editor.mutated() && write) {
      await writeFile(fullPath, editor.text(), 'utf8');
    }
  }

  return { applied, skipped };
}

/**
 * Line-targeted JSONC editor. We deliberately do NOT round-trip the file
 * through JSON.parse / JSON.stringify because that strips comments,
 * trailing commas, and the team's original indentation — exactly the
 * formatting choices that make a config human-readable in code review.
 *
 * Instead, we locate the relevant `enabled` or `disabled` line by
 * walking the comment-stripped text with brace counting (so we never
 * confuse a nested object's `enabled` with the server's own), then
 * splice the value on the original line. Everything else in the file
 * is byte-identical to what the user authored.
 */
class JsonLineEditor {
  private lines: string[];
  private mutatedFlag = false;

  constructor(originalText: string) {
    this.lines = originalText.split(/\r?\n/);
  }

  mutated(): boolean {
    return this.mutatedFlag;
  }

  text(): string {
    return this.lines.join('\n');
  }

  alignCommandAndArgs(
    serverName: string,
    canonicalCommand: string | undefined,
    canonicalArgs: string[] | undefined
  ): { ok: true } | { ok: false; reason: string } {
    if (canonicalCommand === undefined && canonicalArgs === undefined) {
      return { ok: false, reason: 'canonical surface has neither command nor args to copy' };
    }

    const original = this.text();
    const stripped = stripJsonComments(original);
    const serverKeyLine = lineOfJsonKey(stripped, serverName);
    if (!serverKeyLine) {
      return { ok: false, reason: 'server entry not found in file' };
    }
    const block = findServerBlock(stripped, serverKeyLine);
    if (!block) {
      return { ok: false, reason: 'could not locate server block braces' };
    }

    const lines = stripped.split(/\r?\n/);
    let commandLine: number | undefined;
    let argsLine: number | undefined;
    let argsClosingLine: number | undefined;

    let depth = 0;
    for (let i = block.openLine; i <= block.closeLine; i += 1) {
      const line = lines[i];
      const isDirectChildLine = depth === 1 && i > block.openLine;
      if (isDirectChildLine) {
        if (/"command"\s*:\s*"/.test(line)) {
          commandLine = i;
        }
        const argsMatch = /^(\s*)"args"\s*:\s*\[/.exec(line);
        if (argsMatch) {
          argsLine = i;
          // Single-line array: close bracket on same line.
          if (/\]/.test(line.slice(argsMatch[0].length))) {
            argsClosingLine = i;
          }
        }
      }
      for (const ch of line) {
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
      }
    }

    // Shape-mismatch guard: the canonical surface folds its arguments
    // into the command string (no separate args array) but the target
    // keeps a separate args array. Rewriting the command while leaving
    // the target's args untouched would yield a duplicated, corrupt
    // launch line, so refuse rather than "helpfully" break the config.
    if (canonicalArgs === undefined && argsLine !== undefined) {
      return {
        ok: false,
        reason: 'canonical folds args into the command string but the target keeps a separate "args" array; align manually to avoid a corrupt launch'
      };
    }

    // Validate every edit is applicable BEFORE mutating anything, so a
    // partially-applicable fix never leaves the file half-rewritten.
    const commandRegex = /("command"\s*:\s*)"[^"]*"/;
    const argsRegex = /("args"\s*:\s*)\[[^\]]*\]/;
    if (canonicalCommand !== undefined) {
      if (commandLine === undefined) {
        return { ok: false, reason: 'target server has no "command" field; insertion not supported in v1' };
      }
      if (!commandRegex.test(this.lines[commandLine])) {
        return { ok: false, reason: 'could not locate command value token on its line' };
      }
    }
    if (canonicalArgs !== undefined) {
      if (argsLine === undefined) {
        return { ok: false, reason: 'target server has no "args" field; insertion not supported in v1' };
      }
      if (argsClosingLine !== argsLine) {
        return { ok: false, reason: 'multi-line "args" array; not supported in v1' };
      }
      if (!argsRegex.test(this.lines[argsLine])) {
        return { ok: false, reason: 'could not locate args array token on its line' };
      }
    }

    // All checks passed — apply the edits.
    if (canonicalCommand !== undefined && commandLine !== undefined) {
      this.lines[commandLine] = this.lines[commandLine].replace(commandRegex, `$1"${escapeJsonString(canonicalCommand)}"`);
    }
    if (canonicalArgs !== undefined && argsLine !== undefined) {
      const renderedArgs = canonicalArgs.map((arg) => `"${escapeJsonString(arg)}"`).join(', ');
      this.lines[argsLine] = this.lines[argsLine].replace(argsRegex, `$1[${renderedArgs}]`);
    }

    this.mutatedFlag = true;
    return { ok: true };
  }

  alignEnabledState(serverName: string, enabled: boolean, surface: SurfaceId): { ok: true } | { ok: false; reason: string } {
    const original = this.text();
    const stripped = stripJsonComments(original);
    const serverKeyLine = lineOfJsonKey(stripped, serverName);
    if (!serverKeyLine) {
      return { ok: false, reason: 'server entry not found in file' };
    }

    const block = findServerBlock(stripped, serverKeyLine);
    if (!block) {
      return { ok: false, reason: 'could not locate server block braces' };
    }

    const existing = findEnabledOrDisabledLine(stripped, block);
    if (existing) {
      // In-place value replacement — preserves indentation, comments
      // on the line, trailing commas, everything.
      const newValue = existing.key === 'enabled' ? String(enabled) : String(!enabled);
      const updated = replaceBooleanValue(this.lines[existing.lineIndex], existing.key, newValue);
      if (!updated) {
        return { ok: false, reason: 'value replacement could not locate boolean token' };
      }
      this.lines[existing.lineIndex] = updated;
      this.mutatedFlag = true;
      return { ok: true };
    }

    // Field absent — insertion path. Determine child indent and any
    // trailing-comma convention from existing children, then splice a
    // new line in just before the server block's closing brace.
    const inserted = insertEnabledLine(this.lines, block, surface, enabled);
    if (!inserted.ok) {
      return inserted;
    }
    this.mutatedFlag = true;
    return { ok: true };
  }
}

interface ServerBlock {
  /** 0-indexed line containing the opening `{` of the server's value. */
  openLine: number;
  /** 0-indexed line containing the matching closing `}`. */
  closeLine: number;
}

function findServerBlock(stripped: string, serverKeyLine: number): ServerBlock | undefined {
  const lines = stripped.split(/\r?\n/);
  // Find the first '{' on or after the server key line.
  let openLine = -1;
  for (let i = serverKeyLine - 1; i < lines.length; i += 1) {
    if (lines[i].includes('{')) {
      openLine = i;
      break;
    }
  }
  if (openLine < 0) {
    return undefined;
  }

  // From the first '{' on openLine, count braces (respecting strings)
  // until depth returns to zero.
  let depth = 0;
  let started = false;
  let inString = false;
  let escape = false;

  for (let i = openLine; i < lines.length; i += 1) {
    const line = lines[i];
    for (let c = 0; c < line.length; c += 1) {
      const ch = line[c];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === '\\') {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') {
        depth += 1;
        started = true;
      } else if (ch === '}') {
        depth -= 1;
        if (started && depth === 0) {
          return { openLine, closeLine: i };
        }
      }
    }
  }
  return undefined;
}

interface EnabledFieldLocation {
  lineIndex: number; // 0-indexed
  key: 'enabled' | 'disabled';
}

function findEnabledOrDisabledLine(stripped: string, block: ServerBlock): EnabledFieldLocation | undefined {
  const lines = stripped.split(/\r?\n/);
  // We only care about fields DIRECTLY inside the server block, not
  // nested under a child object. Track depth from the open brace.
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = block.openLine; i <= block.closeLine; i += 1) {
    const line = lines[i];
    // Within the body of the server block (depth === 1 after the
    // opening brace), inspect for the enabled/disabled key. Skip the
    // open-line's content before the brace and the close-line's
    // content after.
    const isDirectChildLine = depth === 1 && i > block.openLine;
    if (isDirectChildLine) {
      const match = /"(enabled|disabled)"\s*:\s*(true|false)/.exec(line);
      if (match) {
        return { lineIndex: i, key: match[1] as 'enabled' | 'disabled' };
      }
    }

    // Update depth/state at end of the line by replaying chars.
    for (let c = 0; c < line.length; c += 1) {
      const ch = line[c];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === '\\') {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
        continue;
      }
      if (ch === '"') {
        inString = true;
        continue;
      }
      if (ch === '{') {
        depth += 1;
      } else if (ch === '}') {
        depth -= 1;
      }
    }
  }

  return undefined;
}

function replaceBooleanValue(line: string, key: 'enabled' | 'disabled', newValue: string): string | undefined {
  const regex = new RegExp(`("${key}"\\s*:\\s*)(true|false)`);
  if (!regex.test(line)) {
    return undefined;
  }
  return line.replace(regex, `$1${newValue}`);
}

function insertEnabledLine(
  lines: string[],
  block: ServerBlock,
  surface: SurfaceId,
  enabled: boolean
): { ok: true } | { ok: false; reason: string } {
  const key = PREFERRED_KEY[surface];
  const value = key === 'enabled' ? enabled : !enabled;

  // Sample the indent of the first non-empty line strictly between
  // openLine and closeLine. If the block is empty, indent the new
  // line by adding two spaces to the open line's indent.
  let childIndent: string | undefined;
  for (let i = block.openLine + 1; i < block.closeLine; i += 1) {
    const m = /^(\s+)\S/.exec(lines[i]);
    if (m) {
      childIndent = m[1];
      break;
    }
  }
  if (childIndent === undefined) {
    const openIndentMatch = /^(\s*)/.exec(lines[block.openLine]);
    childIndent = `${openIndentMatch?.[1] ?? ''}  `;
  }

  // Find the previous non-empty line inside the block. If it ends in a
  // value or `]` or `}` without a trailing comma, add one.
  let previousNonEmpty = -1;
  for (let i = block.closeLine - 1; i > block.openLine; i -= 1) {
    if (lines[i].trim().length > 0) {
      previousNonEmpty = i;
      break;
    }
  }
  if (previousNonEmpty < 0) {
    return { ok: false, reason: 'cannot insert into empty server block in v1' };
  }

  const prev = lines[previousNonEmpty];
  const prevTrim = prev.replace(/\s+$/, '');
  if (!/[,]\s*(?:\/\/.*)?$/.test(prevTrim) && !prevTrim.endsWith(',')) {
    lines[previousNonEmpty] = `${prevTrim},${prev.slice(prevTrim.length)}`;
  }

  const newLine = `${childIndent}"${key}": ${value}`;
  lines.splice(block.closeLine, 0, newLine);
  return { ok: true };
}

function escapeJsonString(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
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
    for (const skip of applied.skipped) {
      lines.push(`- ${skip.fix.description} (${skip.reason})`);
    }
  }
  return `${lines.join('\n')}\n`;
}
