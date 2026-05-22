export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type SurfaceId =
  | 'root_mcp'
  | 'cursor_mcp'
  | 'vscode_mcp'
  | 'codeium_mcp'
  | 'windsurf_mcp'
  | 'claude'
  | 'codex';

export interface Finding {
  kind: string;
  severity: Severity;
  file: string;
  line?: number;
  locations?: FindingLocation[];
  subject: string;
  message: string;
  recommendation: string;
  surfaces: SurfaceId[];
}

export interface FindingLocation {
  file: string;
  line?: number;
  surface?: SurfaceId;
}

export interface McpServer {
  name: string;
  command: string;
  enabled: boolean;
  env: Record<string, string>;
  headers: Record<string, string>;
  unpinned: boolean;
  line?: number;
  file: string;
  surfaceId: SurfaceId;
}

export interface McpSurface {
  surfaceId: SurfaceId;
  file: string;
  servers: McpServer[];
}

export interface ClaudePolicy {
  surfaceId: 'claude';
  file: string;
  allow: Map<string, number | undefined>;
  deny: Map<string, number | undefined>;
  hooks: Set<string>;
}

export interface CodexPolicy {
  surfaceId: 'codex';
  file: string;
  sandbox?: string;
  sandboxLine?: number;
  approvalPolicy?: string;
  networkAccess?: boolean;
  networkLine?: number;
  trusted?: boolean;
  trustLine?: number;
}

export interface RepoPolicies {
  mcpSurfaces: McpSurface[];
  claude?: ClaudePolicy;
  codex?: CodexPolicy;
  parseFindings?: Finding[];
}

export interface MatrixRow {
  capability: string;
  values: Partial<Record<SurfaceId, string>>;
}

export type MeshRating = 'none' | Severity;

export type ReportFormat = 'text' | 'markdown' | 'json' | 'github';

export interface MeshReport {
  rating: MeshRating;
  findingCount: number;
  surfaceCount: number;
  findings: Finding[];
  effectiveUnion: string[];
  matrix: MatrixRow[];
}
