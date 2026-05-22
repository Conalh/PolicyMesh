import { access } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import type { Finding, McpServer, RepoPolicies } from '../types.js';

const SCRIPT_EXTENSIONS = [
  '.js', '.mjs', '.cjs', '.ts',
  '.py',
  '.sh', '.bash',
  '.rb',
  '.exe', '.bat', '.cmd', '.ps1'
];

/**
 * Returns the candidate local script path declared on an MCP server, if
 * any. We look at `command` first (e.g. `command: "./scripts/run.sh"`)
 * and fall back to args[0] (e.g. `command: "node", args: ["./tools/x.js"]`).
 * Returns undefined when the launch invocation is not a local-script
 * reference — typically because it's a system binary, a package name,
 * or a URL.
 */
export function localScriptCandidate(server: Pick<McpServer, 'command' | 'args'>): string | undefined {
  const commandToken = firstToken(server.command);
  if (looksLikeLocalScript(commandToken)) {
    return commandToken;
  }

  const firstArg = server.args?.[0];
  if (firstArg && looksLikeLocalScript(firstArg)) {
    return firstArg;
  }

  return undefined;
}

function firstToken(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  const space = trimmed.indexOf(' ');
  return space === -1 ? trimmed : trimmed.slice(0, space);
}

function looksLikeLocalScript(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  if (value.includes('://')) {
    return false;
  }
  if (isAbsolute(value)) {
    return false;
  }
  // Windows drive-letter check — isAbsolute on POSIX wouldn't catch "C:\…"
  if (/^[A-Za-z]:[\\/]/.test(value)) {
    return false;
  }
  if (!value.includes('/') && !value.includes('\\')) {
    return false;
  }

  const lower = value.toLowerCase();
  return SCRIPT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export async function detectMissingLocalScripts(policies: RepoPolicies, root: string): Promise<Finding[]> {
  const findings: Finding[] = [];

  for (const surface of policies.mcpSurfaces) {
    for (const server of surface.servers) {
      const candidate = localScriptCandidate(server);
      if (!candidate) {
        continue;
      }

      const resolved = resolve(root, candidate);
      const exists = await fileExists(resolved);
      if (exists) {
        continue;
      }

      findings.push({
        kind: 'policy_mesh.missing_local_script',
        severity: 'medium',
        file: server.file,
        line: server.line,
        subject: server.name,
        message: `MCP server "${server.name}" references local script "${candidate}", which does not exist in the repository.`,
        recommendation: 'Add the missing script, fix the path, or remove the server from this surface.',
        surfaces: [server.surfaceId]
      });
    }
  }

  return findings;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
