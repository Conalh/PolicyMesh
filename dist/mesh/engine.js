import { isBroadAllow, isSensitiveDeny } from '../parsers/claude.js';
import { codexSandboxRank } from '../parsers/codex.js';
import { matchSecret } from './secrets.js';
import { detectPrivilegedCommands } from './privileged.js';
export function runMeshRules(policies) {
    const findings = [
        ...detectMcpCommandMismatch(policies),
        ...detectMcpServerMissing(policies),
        ...detectMcpEnabledMismatch(policies),
        ...detectMcpEnvMismatch(policies),
        ...detectMcpHeaderMismatch(policies),
        ...detectMcpUnpinned(policies),
        ...detectHardcodedSecrets(policies),
        ...detectPrivilegedCommands(policies),
        ...detectClaudeMcpGrantMissingServer(policies),
        ...detectClaudeDenyAllowOverlap(policies),
        ...detectClaudeBroadAllowNoGuard(policies),
        ...detectCodexNetworkWithoutReview(policies),
        ...detectCodexTrustedWithRiskyMcp(policies),
        ...detectCodexClaudePostureGap(policies)
    ];
    return findings;
}
function detectHardcodedSecrets(policies) {
    const findings = [];
    for (const surface of policies.mcpSurfaces) {
        for (const server of surface.servers) {
            const hit = findServerSecret(server);
            if (!hit) {
                continue;
            }
            findings.push({
                kind: 'policy_mesh.hardcoded_secret',
                severity: 'critical',
                file: server.file,
                line: server.line,
                subject: server.name,
                message: `MCP server "${server.name}" appears to embed a ${hit.provider} credential in ${hit.field}. Hardcoded secrets in agent configs leak through git history.`,
                recommendation: 'Replace the literal value with an environment-variable reference (e.g., env:VAR in Codex, ${env:VAR} in VS Code) and rotate the exposed credential immediately.',
                surfaces: [server.surfaceId]
            });
        }
    }
    return findings;
}
function findServerSecret(server) {
    const commandMatch = matchSecret(server.command);
    if (commandMatch) {
        return { provider: commandMatch.provider, field: 'launch command' };
    }
    for (const [key, value] of Object.entries(server.env)) {
        const envMatch = matchSecret(value, { envOrHeaderContext: true });
        if (envMatch) {
            return { provider: envMatch.provider, field: `env variable ${key}` };
        }
    }
    for (const [key, value] of Object.entries(server.headers)) {
        const headerMatch = matchSecret(value, { envOrHeaderContext: true });
        if (headerMatch) {
            return { provider: headerMatch.provider, field: `header ${key}` };
        }
    }
    return undefined;
}
function detectClaudeMcpGrantMissingServer(policies) {
    const claude = policies.claude;
    if (!claude) {
        return findingsEmpty();
    }
    const configuredServers = new Set(policies.mcpSurfaces
        .flatMap((surface) => surface.servers)
        .map((server) => server.name.toLowerCase()));
    const mcpSurfaces = uniqueSurfaces(policies.mcpSurfaces.map((surface) => surface.surfaceId));
    const findings = [];
    for (const [permission, line] of claude.allow) {
        const server = claudeMcpServerName(permission);
        if (!server || configuredServers.has(server.toLowerCase())) {
            continue;
        }
        findings.push({
            kind: 'policy_mesh.claude_mcp_grant_missing_server',
            severity: 'medium',
            file: claude.file,
            line,
            locations: [{ file: claude.file, line, surface: 'claude' }],
            subject: permission,
            message: `Claude grants MCP server "${server}" via "${permission}", but no MCP config defines that server.`,
            recommendation: 'Define the server in an MCP config file or remove the Claude MCP permission if the server is not intended.',
            surfaces: uniqueSurfaces(['claude', ...mcpSurfaces])
        });
    }
    return findings;
}
function detectMcpCommandMismatch(policies) {
    const findings = [];
    const byName = groupMcpServersByName(policies);
    for (const [name, servers] of byName) {
        // Group by canonical identity, not raw command string, so neutral
        // differences (npx -y vs npx, .cmd/.exe suffix, flag reordering)
        // don't produce false-positive mcp_command_mismatch findings.
        const byIdentity = new Map();
        for (const server of servers) {
            const existing = byIdentity.get(server.canonicalIdentity) ?? [];
            existing.push(server);
            byIdentity.set(server.canonicalIdentity, existing);
        }
        if (byIdentity.size <= 1) {
            continue;
        }
        // Message still shows the user-visible commands so the finding is
        // actionable — even though grouping was on canonical identity.
        const commandList = [...new Set(servers.map((s) => s.command))]
            .map((cmd) => `"${cmd}"`)
            .join(' vs ');
        const primary = servers[0];
        findings.push({
            kind: 'policy_mesh.mcp_command_mismatch',
            severity: 'high',
            file: primary.file,
            line: primary.line,
            locations: servers.map((server) => ({
                file: server.file,
                line: server.line,
                surface: server.surfaceId
            })),
            subject: name,
            message: `MCP server "${name}" has different launch commands across surfaces: ${commandList}.`,
            recommendation: 'Use the same pinned MCP server definition in every MCP config file, or rename servers that intentionally differ.',
            surfaces: uniqueSurfaces(servers.map((s) => s.surfaceId))
        });
    }
    return findings;
}
function detectMcpServerMissing(policies) {
    const findings = [];
    if (policies.mcpSurfaces.length < 2) {
        return findings;
    }
    const byName = groupMcpServersByName(policies);
    const surfaceIds = policies.mcpSurfaces.map((s) => s.surfaceId);
    const surfaceById = new Map(policies.mcpSurfaces.map((surface) => [surface.surfaceId, surface]));
    for (const [name, servers] of byName) {
        const present = new Set(servers.map((s) => s.surfaceId));
        const missing = surfaceIds.filter((id) => !present.has(id));
        if (missing.length === 0) {
            continue;
        }
        const primary = servers[0];
        findings.push({
            kind: 'policy_mesh.mcp_server_missing',
            severity: 'low',
            file: primary.file,
            line: primary.line,
            locations: [
                ...servers.map((server) => ({
                    file: server.file,
                    line: server.line,
                    surface: server.surfaceId
                })),
                ...missing.map((surfaceId) => ({
                    file: surfaceById.get(surfaceId)?.file ?? primary.file,
                    surface: surfaceId
                }))
            ],
            subject: name,
            message: `MCP server "${name}" is defined in ${formatSurfaceList(uniqueSurfaces(servers.map((s) => s.surfaceId)))} but missing from ${formatSurfaceList(missing)}.`,
            recommendation: 'Align MCP server definitions across all MCP config files or document why a surface intentionally omits the server.',
            surfaces: uniqueSurfaces([...present, ...missing])
        });
    }
    return findings;
}
function detectMcpEnabledMismatch(policies) {
    const findings = [];
    const byName = groupMcpServersByName(policies);
    for (const [name, servers] of byName) {
        if (servers.length < 2) {
            continue;
        }
        const states = new Set(servers.map((server) => server.enabled));
        if (states.size <= 1) {
            continue;
        }
        const primary = servers[0];
        findings.push({
            kind: 'policy_mesh.mcp_enabled_mismatch',
            severity: 'medium',
            file: primary.file,
            line: primary.line,
            locations: servers.map((server) => ({
                file: server.file,
                line: server.line,
                surface: server.surfaceId
            })),
            subject: name,
            message: `MCP server "${name}" is ${summarizeEnabledStates(servers)}.`,
            recommendation: 'Align MCP server enabled/disabled state across surfaces, or rename/document surfaces that intentionally expose different tool access.',
            surfaces: uniqueSurfaces(servers.map((server) => server.surfaceId))
        });
    }
    return findings;
}
function detectMcpEnvMismatch(policies) {
    const findings = [];
    const byName = groupMcpServersByName(policies);
    for (const [name, servers] of byName) {
        if (servers.length < 2) {
            continue;
        }
        const envFingerprints = new Set(servers.map((server) => envFingerprint(server.env)));
        if (envFingerprints.size <= 1) {
            continue;
        }
        const envKeyFingerprints = new Set(servers.map((server) => envKeyFingerprint(server.env)));
        const keySummary = summarizeEnvKeys(servers);
        const primary = servers[0];
        const differingKeys = differingEnvKeys(servers);
        findings.push({
            kind: 'policy_mesh.mcp_env_mismatch',
            severity: 'medium',
            file: primary.file,
            line: primary.line,
            locations: servers.map((server) => ({
                file: server.file,
                line: server.line,
                surface: server.surfaceId
            })),
            subject: name,
            message: envKeyFingerprints.size > 1
                ? `MCP server "${name}" environment variable names differ across surfaces: ${keySummary}.`
                : `MCP server "${name}" environment values differ across surfaces for ${differingKeys.join(', ')}.`,
            recommendation: 'Align MCP server environment variable names and secret sources across surfaces, or document why each agent needs different wiring.',
            surfaces: uniqueSurfaces(servers.map((server) => server.surfaceId))
        });
    }
    return findings;
}
function detectMcpHeaderMismatch(policies) {
    const findings = [];
    const byName = groupMcpServersByName(policies);
    for (const [name, servers] of byName) {
        if (servers.length < 2) {
            continue;
        }
        const headerFingerprints = new Set(servers.map((server) => headerFingerprint(server.headers)));
        if (headerFingerprints.size <= 1) {
            continue;
        }
        const headerKeyFingerprints = new Set(servers.map((server) => headerKeyFingerprint(server.headers)));
        const keySummary = summarizeHeaderKeys(servers);
        const primary = servers[0];
        const differingKeys = differingHeaderKeys(servers);
        findings.push({
            kind: 'policy_mesh.mcp_header_mismatch',
            severity: 'medium',
            file: primary.file,
            line: primary.line,
            locations: servers.map((server) => ({
                file: server.file,
                line: server.line,
                surface: server.surfaceId
            })),
            subject: name,
            message: headerKeyFingerprints.size > 1
                ? `MCP server "${name}" header names differ across surfaces: ${keySummary}.`
                : `MCP server "${name}" header values differ across surfaces for ${differingKeys.join(', ')}.`,
            recommendation: 'Align remote MCP server header names and secret sources across surfaces, or document why each agent needs different remote credentials.',
            surfaces: uniqueSurfaces(servers.map((server) => server.surfaceId))
        });
    }
    return findings;
}
function detectMcpUnpinned(policies) {
    const findings = [];
    for (const surface of policies.mcpSurfaces) {
        for (const server of surface.servers) {
            if (!server.unpinned) {
                continue;
            }
            findings.push({
                kind: 'policy_mesh.mcp_unpinned',
                severity: 'medium',
                file: server.file,
                line: server.line,
                subject: server.name,
                message: `MCP server "${server.name}" uses an unpinned command: ${server.command}.`,
                recommendation: 'Pin executable packages to an exact version and avoid @latest in shared agent configuration.',
                surfaces: [server.surfaceId]
            });
        }
    }
    return findings;
}
function detectClaudeDenyAllowOverlap(policies) {
    const findings = [];
    const claude = policies.claude;
    if (!claude) {
        return findings;
    }
    const broadAllows = [...claude.allow.keys()].filter(isBroadAllow);
    const sensitiveDenies = [...claude.deny.keys()].filter(isSensitiveDeny);
    if (broadAllows.length === 0 || sensitiveDenies.length === 0) {
        return findings;
    }
    for (const deny of sensitiveDenies) {
        const line = claude.deny.get(deny);
        findings.push({
            kind: 'policy_mesh.claude_deny_allow_overlap',
            severity: 'medium',
            file: claude.file,
            line,
            subject: deny,
            message: `Claude denies "${deny}" but also has broad allow rules (${broadAllows.join(', ')}), creating mixed policy signals.`,
            recommendation: 'Narrow broad allow patterns or ensure deny rules are enforced by hooks when permissions overlap.',
            surfaces: ['claude']
        });
    }
    return findings;
}
function detectClaudeBroadAllowNoGuard(policies) {
    const findings = [];
    const claude = policies.claude;
    if (!claude) {
        return findings;
    }
    const broadAllows = [...claude.allow.entries()].filter(([permission]) => isBroadAllow(permission));
    if (broadAllows.length === 0) {
        return findings;
    }
    const hasPreToolUse = [...claude.hooks].some((hook) => hook.toLowerCase() === 'pretooluse');
    if (hasPreToolUse) {
        return findings;
    }
    const [primaryAllow, line] = broadAllows[0];
    findings.push({
        kind: 'policy_mesh.claude_broad_allow_no_guard',
        severity: 'medium',
        file: claude.file,
        line,
        subject: primaryAllow,
        message: `Claude has broad allow rules (${broadAllows.map(([p]) => p).join(', ')}) without a PreToolUse hook.`,
        recommendation: 'Add a PreToolUse hook to guard broad permissions, or narrow allow patterns to the minimum required scope.',
        surfaces: ['claude']
    });
    return findings;
}
function detectCodexNetworkWithoutReview(policies) {
    const codex = policies.codex;
    if (!codex?.networkAccess) {
        return findingsEmpty();
    }
    const otherSurfaces = listOtherAgentSurfaces(policies);
    if (otherSurfaces.length === 0) {
        return findingsEmpty();
    }
    return [{
            kind: 'policy_mesh.codex_network_without_review',
            severity: 'medium',
            file: codex.file,
            line: codex.networkLine,
            subject: 'network_access',
            message: 'Codex network access is enabled while other agent surfaces are also configured in this repository.',
            recommendation: 'Review whether network access is required and ensure secrets cannot be exfiltrated through agent tooling.',
            surfaces: ['codex', ...otherSurfaces]
        }];
}
function detectCodexTrustedWithRiskyMcp(policies) {
    const codex = policies.codex;
    if (!codex?.trusted) {
        return findingsEmpty();
    }
    const findings = [];
    const unpinned = policies.mcpSurfaces.flatMap((s) => s.servers).filter((s) => s.unpinned);
    const hasMismatch = detectMcpCommandMismatch(policies).length > 0;
    if (unpinned.length > 0 || hasMismatch) {
        const risky = unpinned[0];
        findings.push({
            kind: 'policy_mesh.codex_trusted_with_risky_mcp',
            severity: 'high',
            file: risky?.file ?? codex.file,
            line: risky?.line ?? codex.trustLine,
            subject: risky?.name ?? 'projects.trust_level',
            message: hasMismatch && unpinned.length > 0
                ? 'Codex project is trusted while MCP servers are unpinned and inconsistent across surfaces.'
                : unpinned.length > 0
                    ? `Codex project is trusted while MCP server "${risky.name}" is unpinned.`
                    : 'Codex project is trusted while MCP servers have mismatched commands across surfaces.',
            recommendation: 'Do not mark projects trusted until MCP servers are pinned and consistent across all agent surfaces.',
            surfaces: uniqueSurfaces([
                'codex',
                ...policies.mcpSurfaces.flatMap((s) => s.servers.map((srv) => srv.surfaceId))
            ])
        });
    }
    return findings;
}
function detectCodexClaudePostureGap(policies) {
    const codex = policies.codex;
    const claude = policies.claude;
    if (!codex || !claude) {
        return findingsEmpty();
    }
    const sandboxRank = codexSandboxRank(codex.sandbox);
    if (sandboxRank < 1) {
        return findingsEmpty();
    }
    const hasStrictDenies = [...claude.deny.keys()].some(isSensitiveDeny);
    if (!hasStrictDenies) {
        return findingsEmpty();
    }
    return [{
            kind: 'policy_mesh.codex_claude_posture_gap',
            severity: 'medium',
            file: codex.file,
            line: codex.sandboxLine,
            subject: codex.sandbox ?? 'sandbox',
            message: `Codex sandbox is "${codex.sandbox ?? 'widened'}" while Claude has strict deny rules with no equivalent Codex restriction.`,
            recommendation: 'Align Codex sandbox posture with Claude deny rules, or document why Codex requires broader filesystem access.',
            surfaces: ['codex', 'claude']
        }];
}
export function buildEffectiveUnion(policies) {
    const union = [];
    const allServers = policies.mcpSurfaces.flatMap((s) => s.servers);
    const uniqueServerNames = new Set(allServers.map((s) => s.name));
    if (uniqueServerNames.size > 0) {
        union.push(`${uniqueServerNames.size} MCP server${uniqueServerNames.size === 1 ? '' : 's'} configured`);
    }
    const unpinnedCount = allServers.filter((s) => s.unpinned).length;
    if (unpinnedCount > 0) {
        union.push(`${unpinnedCount} unpinned MCP package${unpinnedCount === 1 ? '' : 's'}`);
    }
    if (policies.claude) {
        const broadAllows = [...policies.claude.allow.keys()].filter(isBroadAllow);
        if (broadAllows.some((p) => p.toLowerCase().includes('bash('))) {
            union.push('bash wildcards allowed (Claude)');
        }
        if (broadAllows.some((p) => p.toLowerCase().includes('read('))) {
            union.push('broad read paths allowed (Claude)');
        }
        if (policies.claude.deny.size > 0) {
            union.push(`${policies.claude.deny.size} Claude deny rule${policies.claude.deny.size === 1 ? '' : 's'}`);
        }
        if (policies.claude.hooks.size > 0) {
            union.push(`${policies.claude.hooks.size} Claude hook${policies.claude.hooks.size === 1 ? '' : 's'}`);
        }
    }
    if (policies.codex?.networkAccess) {
        union.push('network enabled (Codex)');
    }
    if (policies.codex?.trusted) {
        union.push('Codex project trusted');
    }
    if (policies.codex?.sandbox) {
        union.push(`Codex sandbox: ${policies.codex.sandbox}`);
    }
    const parseFindingCount = policies.parseFindings?.length ?? 0;
    if (parseFindingCount > 0) {
        union.push(`${parseFindingCount} unreadable agent config${parseFindingCount === 1 ? '' : 's'}`);
    }
    if (union.length === 0) {
        union.push('No agent policy surfaces configured');
    }
    return union;
}
export function buildSurfaceMatrix(policies) {
    const rows = [];
    const byName = groupMcpServersByName(policies);
    for (const [name, servers] of byName) {
        const values = {};
        for (const server of servers) {
            values[server.surfaceId] = truncate(server.command, 48);
        }
        rows.push({ capability: `MCP: ${name}`, values });
    }
    if (policies.claude) {
        for (const [permission] of policies.claude.allow) {
            rows.push({
                capability: `Allow: ${truncate(permission, 40)}`,
                values: { claude: 'allow' }
            });
        }
        for (const [permission] of policies.claude.deny) {
            rows.push({
                capability: `Deny: ${truncate(permission, 40)}`,
                values: { claude: 'deny' }
            });
        }
        for (const hook of policies.claude.hooks) {
            rows.push({
                capability: `Hook: ${hook}`,
                values: { claude: 'present' }
            });
        }
    }
    if (policies.codex) {
        if (policies.codex.sandbox) {
            rows.push({
                capability: 'Codex sandbox',
                values: { codex: policies.codex.sandbox }
            });
        }
        if (policies.codex.approvalPolicy) {
            rows.push({
                capability: 'Codex approval',
                values: { codex: policies.codex.approvalPolicy }
            });
        }
        if (policies.codex.networkAccess !== undefined) {
            rows.push({
                capability: 'Codex network',
                values: { codex: policies.codex.networkAccess ? 'enabled' : 'disabled' }
            });
        }
        if (policies.codex.trusted !== undefined) {
            rows.push({
                capability: 'Codex trust',
                values: { codex: policies.codex.trusted ? 'trusted' : 'untrusted' }
            });
        }
    }
    return rows;
}
function groupMcpServersByName(policies) {
    const byName = new Map();
    for (const surface of policies.mcpSurfaces) {
        for (const server of surface.servers) {
            const existing = byName.get(server.name) ?? [];
            existing.push(server);
            byName.set(server.name, existing);
        }
    }
    return byName;
}
function uniqueSurfaces(surfaces) {
    return [...new Set(surfaces)];
}
function uniqueSorted(values) {
    return [...new Set(values)].sort();
}
function envFingerprint(env) {
    return Object.entries(env)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
}
function envKeyFingerprint(env) {
    return uniqueSorted(Object.keys(env)).join('\n');
}
function differingEnvKeys(servers) {
    const keys = uniqueSorted(servers.flatMap((server) => Object.keys(server.env)));
    return keys.filter((key) => {
        const values = new Set(servers.map((server) => server.env[key] ?? '<unset>'));
        return values.size > 1;
    });
}
function summarizeEnvKeys(servers) {
    return servers
        .map((server) => {
        const keys = uniqueSorted(Object.keys(server.env));
        return `${surfaceLabel(server.surfaceId)} uses ${keys.length > 0 ? keys.join(', ') : 'no env variables'}`;
    })
        .join('; ');
}
function headerFingerprint(headers) {
    return Object.entries(headers)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
}
function headerKeyFingerprint(headers) {
    return uniqueSorted(Object.keys(headers)).join('\n');
}
function differingHeaderKeys(servers) {
    const keys = uniqueSorted(servers.flatMap((server) => Object.keys(server.headers)));
    return keys.filter((key) => {
        const values = new Set(servers.map((server) => server.headers[key] ?? '<unset>'));
        return values.size > 1;
    });
}
function summarizeHeaderKeys(servers) {
    return servers
        .map((server) => {
        const keys = uniqueSorted(Object.keys(server.headers));
        return `${surfaceLabel(server.surfaceId)} uses ${keys.length > 0 ? keys.join(', ') : 'no headers'}`;
    })
        .join('; ');
}
function summarizeEnabledStates(servers) {
    return servers
        .map((server) => `${server.enabled ? 'enabled' : 'disabled'} in ${surfaceLabel(server.surfaceId)}`)
        .join('; ');
}
function formatSurfaceList(surfaces) {
    return surfaces.map(surfaceLabel).join(', ');
}
function surfaceLabel(surface) {
    const labels = {
        root_mcp: 'Root MCP',
        cursor_mcp: 'Cursor MCP',
        vscode_mcp: 'VS Code MCP',
        codeium_mcp: 'Codeium MCP',
        windsurf_mcp: 'Windsurf MCP',
        claude: 'Claude',
        codex: 'Codex'
    };
    return labels[surface];
}
function listOtherAgentSurfaces(policies) {
    const surfaces = policies.mcpSurfaces
        .map((surface) => surface.surfaceId)
        .filter((surface) => surface !== 'codex');
    if (policies.claude) {
        surfaces.push('claude');
    }
    for (const finding of policies.parseFindings ?? []) {
        surfaces.push(...finding.surfaces.filter((surface) => surface !== 'codex'));
    }
    return uniqueSurfaces(surfaces);
}
function truncate(value, max) {
    return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}
function findingsEmpty() {
    return [];
}
function claudeMcpServerName(permission) {
    const start = permission.toLowerCase().indexOf('mcp__');
    if (start === -1) {
        return undefined;
    }
    if (start > 0 && /[a-z0-9_]/i.test(permission[start - 1])) {
        return undefined;
    }
    const grant = permission.slice(start + 'mcp__'.length).match(/^[A-Za-z0-9_*-]+/)?.[0] ?? '';
    const server = grant.split('__')[0];
    if (!server || server.includes('*')) {
        return undefined;
    }
    return server;
}
