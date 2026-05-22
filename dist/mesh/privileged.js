import { basename } from 'node:path';
const PRIVILEGED_TOKENS = new Set([
    'sudo',
    'sudoedit',
    'doas',
    'pkexec',
    'runas',
    'gsudo'
]);
/**
 * Returns the privileged elevation utility a server invokes, if any.
 * We look at the basename of the command's first token (covers
 * "sudo node x.js" and "/usr/bin/sudo") and args[0] (covers the
 * rare "command: 'env', args: ['sudo', ...]" shape). Matching is
 * case-insensitive to handle Windows RUNAS / GSUDO variants.
 */
export function privilegedToken(server) {
    const commandFirst = firstToken(server.command);
    if (commandFirst) {
        const token = normalizeBinaryName(commandFirst);
        if (PRIVILEGED_TOKENS.has(token)) {
            return token;
        }
    }
    const firstArg = server.args?.[0];
    if (firstArg) {
        const token = normalizeBinaryName(firstArg);
        if (PRIVILEGED_TOKENS.has(token)) {
            return token;
        }
    }
    return undefined;
}
function firstToken(value) {
    const trimmed = value.trim();
    if (!trimmed) {
        return undefined;
    }
    const space = trimmed.indexOf(' ');
    return space === -1 ? trimmed : trimmed.slice(0, space);
}
function normalizeBinaryName(value) {
    // basename handles POSIX paths; manual split covers Windows backslashes too.
    const stripped = basename(value.replace(/\\/g, '/'));
    return stripped.replace(/\.(exe|bat|cmd|ps1)$/i, '').toLowerCase();
}
export function detectPrivilegedCommands(policies) {
    const findings = [];
    for (const surface of policies.mcpSurfaces) {
        for (const server of surface.servers) {
            const token = privilegedToken(server);
            if (!token) {
                continue;
            }
            findings.push({
                kind: 'policy_mesh.privileged_command',
                severity: 'high',
                file: server.file,
                line: server.line,
                subject: server.name,
                message: `MCP server "${server.name}" launches via "${token}", which elevates privileges before the agent runs.`,
                recommendation: 'Run MCP servers in user-space. Move privileged operations behind explicit user prompts or remove the elevation entirely.',
                surfaces: [server.surfaceId]
            });
        }
    }
    return findings;
}
