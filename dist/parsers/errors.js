const SURFACE_NAMES = {
    root_mcp: 'Root MCP',
    cursor_mcp: 'Cursor MCP',
    vscode_mcp: 'VS Code MCP',
    windsurf_mcp: 'Codeium/Windsurf MCP',
    claude: 'Claude',
    codex: 'Codex'
};
export function configParseFinding(file, surface, parseError) {
    const syntax = surface === 'codex' ? 'TOML' : 'JSON';
    return {
        kind: 'config_parse_error',
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
