# Changelog

All notable changes to this project will be documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Under v1.0, minor versions may carry breaking changes.

## [0.5.1] — 2026-05-28

### Fixed
- **Secret detection now uses agent-gov-core's `matchSecret`** instead of a stale vendored copy, so hardcoded-credential findings stay in sync with the suite's shared provider-prefix and entropy rules rather than drifting against an out-of-date local table.

### Changed
- **GitHub annotations are now severity-aware.** `high` and `critical` findings emit `::error` annotations; `medium` and `low` stay `::warning`. This matches the annotation contract in agent-gov-core (and GovVerdict), so a critical policy finding no longer shows up as a yellow warning in the PR diff. Exit-code gating is unchanged — that is still controlled by `--fail-on`.

### Internal
- Bumped `agent-gov-core` dependency `^1.0.0` → `^1.2.1`.

## [0.5.0] — 2026-05-22

**BREAKING** — JSON output now emits the canonical agent-gov-core `Report` envelope so the cross-tool meta-reviewer (GovVerdict) can ingest one shape across the whole suite.

### Changed (breaking)
- `--format json` output replaces the legacy `MeshReport` shape (`{ rating, findingCount, surfaceCount, findings, effectiveUnion, matrix, resolvedFindings? }`) with the canonical `Report` envelope: `{ schemaVersion: '1.0', tool: 'policy_mesh', rating, findings, data: { surfaceCount, effectiveUnion, matrix, resolvedFindings? } }`. The aggregate rating remains accessible at `.rating` (same path); the previous `.findingCount` is now `.findings.length`; the PolicyMesh-specific extras move under `.data.*`.
- Each emitted finding moves the flat `file` / `line` fields into a structured `location: { file, line }` per the canonical `Finding` schema. PolicyMesh-specific extras (`subject`, `recommendation`, `surfaces`, `signature`, multi-location `locations[]`) ride along under `data.*` per finding.
- `policymesh render` and `policymesh diff --base-report/--head-report` now **only** accept the canonical envelope as input; pre-0.5.0 reports raise a clear error pointing at the migration. Re-run `policymesh audit` against the source repository to regenerate.
- `action.yml`: the Action step's `finding-count` and `surface-count` outputs now derive from `.findings.length` and `.data.surfaceCount` respectively. Action-level output keys are unchanged.

### Why
- Closes the envelope mismatch that forced GovVerdict to carry a legacy adapter in `src/load.ts`. After all five consumers migrate, the adapter is deleted in GovVerdict v0.2.0.
- Unblocks the agent-gov-core v1.0 schema freeze: every consumer now flows through `createReport` + `createFinding`, so the canonical envelope is the only contract downstream tools depend on.

### Internal
- Internal `MeshReport` type retained — markdown / text / GitHub annotation / SARIF renderers still consume it directly. `toCanonicalReport` and `fromCanonicalReport` bridge the JSON serialization edge in both directions (`audit`/`diff` write canonical; `render`/`diff --base-report` read canonical).
