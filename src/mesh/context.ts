import type { McpServer, RepoPolicies, SurfaceId } from '../types.js';

/**
 * Shared state for one audit run, computed once and passed to detectors
 * that would otherwise rebuild the same indexes per call. New detectors
 * should accept a MeshContext so cross-rule lookups stay O(1) rather
 * than re-iterating policies for each rule.
 *
 * The substrate is intentionally minimal in v0.4 — only the fields with
 * a current consumer are populated. Adding new fields here is cheaper
 * than touching every detector signature later.
 */
export interface MeshContext {
  policies: RepoPolicies;
  serversByName: ReadonlyMap<string, McpServer[]>;
  mcpSurfaceIds: readonly SurfaceId[];
  allMcpServers: readonly McpServer[];
}

export function makeMeshContext(policies: RepoPolicies): MeshContext {
  const serversByName = new Map<string, McpServer[]>();
  const allMcpServers: McpServer[] = [];
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
