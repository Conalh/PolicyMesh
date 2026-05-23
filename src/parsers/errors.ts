import type { Finding, SurfaceId } from '../types.js';
import type { JsonParseError } from '../discovery.js';

const SURFACE_NAMES: Record<SurfaceId, string> = {
  root_mcp: 'Root MCP',
  cursor_mcp: 'Cursor MCP',
  vscode_mcp: 'VS Code MCP',
  codeium_mcp: 'Codeium MCP',
  windsurf_mcp: 'Windsurf MCP',
  claude: 'Claude',
  codex: 'Codex',
  aider: 'Aider',
  instructions: 'Instructions'
};

export function configParseFinding(file: string, surface: SurfaceId, parseError: JsonParseError): Finding {
  const syntax = surface === 'codex' ? 'TOML' : 'JSON';

  return {
    kind: 'policy_mesh.config_parse_error',
    severity: 'high',
    file,
    line: parseError.line,
    locations: [{ file, line: parseError.line, surface }],
    subject: file,
    message: `Could not parse ${SURFACE_NAMES[surface]} config at ${file}: ${parseError.message}.`,
    recommendation: `Fix the ${syntax} syntax so PolicyMesh can audit this agent policy surface.`,
    surfaces: [surface]
  };
}
