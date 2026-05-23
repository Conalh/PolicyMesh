export type Severity = 'low' | 'medium' | 'high' | 'critical';

export type SurfaceId =
  | 'root_mcp'
  | 'cursor_mcp'
  | 'vscode_mcp'
  | 'codeium_mcp'
  | 'windsurf_mcp'
  | 'claude'
  | 'codex'
  | 'aider';

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
  /**
   * Short, content-derived hash that captures the *meaning* of the
   * finding (subject + file + normalized message). Stable across
   * audit runs as long as the underlying violation is unchanged.
   * Users paste this into a .policymesh-exceptions.json entry's
   * `signature` field to lock the exception to the specific
   * violation that was reviewed — if the violation later changes
   * (e.g. a command gets rewritten), the signature stops matching
   * and the exception no longer suppresses.
   */
  signature?: string;
}

export interface FindingLocation {
  file: string;
  line?: number;
  surface?: SurfaceId;
}

export interface McpServer {
  name: string;
  /** Human-readable launch string. Used in messages/matrix rows only. */
  command: string;
  /**
   * Canonical identity of the launch command from agent-gov-core's
   * normalizeMcpCommand, computed *without* env. Two servers with the same
   * canonicalIdentity launch the same workload, even if their raw command
   * strings differ in neutral ways (flag reordering, `-y`/`--yes`,
   * `.cmd`/`.exe` suffix). The mismatch detector groups by this field,
   * not by `command`. Env differences are reported separately by
   * mcp_env_mismatch and intentionally excluded here.
   */
  canonicalIdentity: string;
  enabled: boolean;
  env: Record<string, string>;
  headers: Record<string, string>;
  /** Raw command argument list as authored in the config, preserved so
   *  detectors can inspect individual tokens (e.g. local script paths)
   *  without re-parsing the joined command string. */
  args?: string[];
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

export interface AiderPolicy {
  surfaceId: 'aider';
  file: string;
  model?: string;
  autoCommits?: boolean;
  dangerouslyAllowNonGit?: boolean;
  dangerouslyAllowNonGitLine?: number;
  autoAcceptArchitect?: boolean;
}

export interface RepoPolicies {
  mcpSurfaces: McpSurface[];
  claude?: ClaudePolicy;
  codex?: CodexPolicy;
  aider?: AiderPolicy;
  parseFindings?: Finding[];
}

export interface Exception {
  /** Finding kind to suppress, e.g. "policy_mesh.mcp_enabled_mismatch". */
  kind: string;
  /** Literal Finding.subject to match. No glob support in v1. */
  subject: string;
  /** Free-form explanation. Not interpreted by the engine. */
  reason?: string;
  /**
   * ISO date (YYYY-MM-DD). When set and in the past, the matching
   * finding is surfaced back with severity downgraded and an
   * "[EXPIRED WHITELIST]" prefix on the message.
   */
  expiry?: string;
  /**
   * Optional content-derived hash from the finding the reviewer
   * approved. When present, the exception suppresses only when the
   * current finding's signature matches — if the underlying violation
   * changes (e.g. a command is rewritten to something dangerous), the
   * signature mismatches and the finding re-fires for re-review.
   * Omit to suppress purely by kind+subject (the v0.2.0 behavior).
   */
  signature?: string;
}

export interface MatrixRow {
  capability: string;
  values: Partial<Record<SurfaceId, string>>;
}

export type MeshRating = 'none' | Severity;

export type ReportFormat = 'text' | 'markdown' | 'json' | 'github' | 'sarif';

export interface MeshReport {
  rating: MeshRating;
  findingCount: number;
  surfaceCount: number;
  findings: Finding[];
  effectiveUnion: string[];
  matrix: MatrixRow[];
  /**
   * Set only by `policymesh diff`. Findings that were present in the
   * base report but absent in head — i.e. resolved by the changes
   * under review. Optional and non-breaking: consumers that don't
   * know about it just ignore the field.
   */
  resolvedFindings?: Finding[];
}
