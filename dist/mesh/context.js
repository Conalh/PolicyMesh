export function makeMeshContext(policies) {
    const serversByName = new Map();
    const allMcpServers = [];
    for (const surface of policies.mcpSurfaces) {
        for (const server of surface.servers) {
            const existing = serversByName.get(server.name) ?? [];
            existing.push(server);
            serversByName.set(server.name, existing);
            allMcpServers.push(server);
        }
    }
    return {
        policies,
        serversByName,
        mcpSurfaceIds: policies.mcpSurfaces.map((surface) => surface.surfaceId),
        allMcpServers
    };
}
