# PolicyMesh

[![CI](https://github.com/Conalh/PolicyMesh/actions/workflows/ci.yml/badge.svg)](https://github.com/Conalh/PolicyMesh/actions/workflows/ci.yml)
[![PolicyMesh](https://github.com/Conalh/PolicyMesh/actions/workflows/policymesh.yml/badge.svg)](https://github.com/Conalh/PolicyMesh/actions/workflows/policymesh.yml)
[![Release](https://img.shields.io/github/v/release/Conalh/PolicyMesh)](https://github.com/Conalh/PolicyMesh/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Cross-surface AI agent policy consistency review.

PolicyMesh is a free OSS CLI and GitHub Action that audits a repository for contradictory or inconsistent AI-agent configuration across surfaces.

- `.mcp.json`
- `.cursor/mcp.json`
- `.vscode/mcp.json`
- `.codeium/mcp_config.json`
- `.codeium/windsurf/mcp_config.json`
- Codex MCP tables in `.codex/config.toml`
- `.claude/settings.json`
- `.codex/config.toml`
- `.aider.conf.yml`
- Instruction surfaces: `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*.md`, `.github/copilot-instructions.md`
- Surface matrix, effective capability union, and conflict findings
- Terminal, Markdown, JSON, and line-level GitHub annotation output
- GitHub Action step summaries and PR-visible warnings

It is intentionally not a hosted scanner. The Action reads the checked-out repository, uploads nothing by default, and starts advisory with `fail-on: none`.

**ScopeTrail catches permission drift in PRs. PolicyMesh catches contradictory agent policies in the repo.**

## Part of an AI-agent governance suite

Five tools mapping orthogonal failure modes of AI-agent deployment:

- **[ScopeTrail](https://github.com/Conalh/ScopeTrail)** — config drift over time (PR-level).
- **PolicyMesh** *(this repo)* — policy contradictions across agent surfaces.
- **[CapabilityEcho](https://github.com/Conalh/CapabilityEcho)** — capability drift via code, not config.
- **[TaskBound](https://github.com/Conalh/TaskBound)** — scope creep after the agent runs.
- **[SessionTrail](https://github.com/Conalh/SessionTrail)** — runtime behavior review across agent session transcripts.

[docs/workflows/agent-governance.yml](docs/workflows/agent-governance.yml) is a drop-in workflow template that runs ScopeTrail + PolicyMesh + CapabilityEcho together in one job per PR.

ScopeTrail, PolicyMesh, and CapabilityEcho are preventive (static analysis of config and code). SessionTrail is runtime (in-session transcript review). TaskBound is detective (stated task vs. actual diff).

## Demo

Original demo PR: [Demo: cross-surface agent policy conflicts](https://github.com/Conalh/PolicyMesh/pull/1)

The original PR intentionally adds:

- The same `github` MCP server with different launch commands in `.mcp.json` and `.cursor/mcp.json`.
- An unpinned `@latest` MCP package in Cursor config.
- Broad Claude allow rules with a narrow `.env` deny and no `PreToolUse` hook.
- Codex network access and trusted project settings alongside the risky MCP setup.

PolicyMesh reports `HIGH` policy conflicts and emits GitHub warning annotations on those conflicting config lines.

The default branch does not keep intentionally conflicted root configs checked in. The original PR preserves the PR-visible annotation proof, and the fixture below keeps the fuller current scenario reproducible locally without making every future pull request noisy.

Run PolicyMesh locally against the conflicted fixture:

```powershell
npm install
npm run build
node dist/index.js audit --repo test/fixtures/conflicted --format markdown
```

The local fixture extends that proof with:

- The same `github` MCP server with different launch commands in `.mcp.json` and `.cursor/mcp.json`.
- VS Code and Windsurf MCP configs participating in the same cross-surface mismatch.
- A Codex MCP table in `.codex/config.toml` participating in the same cross-surface mismatch.
- An unpinned `@latest` MCP package in Cursor config.
- Broad Claude allow rules with a narrow `.env` deny and no `PreToolUse` hook.
- Codex network access and trusted project settings alongside the risky MCP setup.

PolicyMesh reports `HIGH` policy conflicts and emits GitHub warning annotations on the conflicting config lines.

## Local Use

```powershell
npx policymesh@latest audit --repo . --format markdown
```

Or, if you have the repo checked out and want to hack on it:

```powershell
npm install
npm run build
node dist/index.js audit --repo . --format markdown
```

Supported formats: `text` (default, ANSI-coloured in a TTY), `markdown`, `json`, `github` (PR annotations), and `sarif` (SARIF 2.1.0 for the GitHub Security tab and other SAST consumers).

```powershell
npx policymesh@latest audit --repo . --format sarif > policymesh.sarif
# Then in a workflow:
# - uses: github/codeql-action/upload-sarif@v3
#   with:
#     sarif_file: policymesh.sarif
```

### Auto-fix mode

PolicyMesh ships a narrow `fix` subcommand that aligns enabled/disabled state across MCP surfaces to a canonical source of truth:

```powershell
node dist/index.js fix --repo . --canonical root_mcp           # dry-run
node dist/index.js fix --repo . --canonical root_mcp --write   # apply
```

The `--canonical` flag is required because the engine cannot guess which surface holds the intended policy. v1 only handles `mcp_enabled_mismatch` and only edits JSON MCP surfaces (Codex TOML is out of scope). `--write` performs line-targeted in-place edits that preserve comments, trailing commas, and original indentation — only the boolean token on the existing `enabled`/`disabled` line changes.

### Monorepos

Pass `--recursive` (or `-r`) to discover sub-projects with their own agent configs (e.g. `apps/web/.mcp.json`, `apps/api/.codex/config.toml`) and audit each independently:

```powershell
node dist/index.js audit --repo . --recursive --format markdown
```

PolicyMesh walks the tree (skipping `node_modules`, `.git`, `dist`, common build outputs, etc.), runs the standard audit per detected project, and merges the findings. Cross-surface rules fire **within** a project, not across projects — an MCP server named `github` defined the same way in two unrelated sub-projects is not a mismatch.

Each project's findings keep their relative file paths (`apps/api/.mcp.json:5`) so CI annotations point to the right line, and the surface matrix tags every row with its sub-project for easy scanning.

## GitHub Action

Add this workflow to review agent policy consistency on pull requests:

```yaml
name: PolicyMesh

on:
  pull_request:

permissions:
  contents: read

jobs:
  policymesh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0   # required for diff mode to see the PR base ref

      - uses: Conalh/PolicyMesh@v0.3.0
        with:
          fail-on: high
          diff: true
```

**PR delta mode (`diff: true`) is the recommended default**: PolicyMesh audits the PR base ref in a temporary worktree, audits HEAD, and emits PR annotations only for findings that this PR **introduces or worsens**. The `rating` / `finding-count` outputs and `fail-on` threshold gate on the delta, so a PR that doesn't introduce new conflicts passes even when the repo has pre-existing findings. The step summary still shows the full head report for context. Findings whose severity rose in head are marked `[WORSENED from <severity>]` in the message; findings present in base but absent in head are surfaced as a `Resolved by this PR` section — green-check signal alongside the warnings.

For the simpler full-snapshot mode (audits every finding on every PR, no `fetch-depth: 0` required):

```yaml
      - uses: actions/checkout@v6
      - uses: Conalh/PolicyMesh@v0.3.0
        with:
          fail-on: none
```

The action runs the bundled CLI from the published tag and uploads nothing by default. It writes a Markdown report to the GitHub Actions step summary and emits PR-visible warning annotations.

### Optional: sticky PR comment

Pass `github-token: ${{ secrets.GITHUB_TOKEN }}` to have PolicyMesh post the Markdown report as a single PR comment that updates in place across pushes (rather than spamming a new comment per run):

```yaml
permissions:
  contents: read
  pull-requests: write   # required only when using github-token

jobs:
  policymesh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: Conalh/PolicyMesh@v0.3.0
        with:
          fail-on: none
          github-token: ${{ secrets.GITHUB_TOKEN }}
```

Without `github-token`, the action runs with the minimal `contents: read` permission — step summary and warning annotations only.

### Optional: monorepo mode

Set `recursive: true` to audit every sub-project with its own agent config independently. Findings keep their relative file paths so PR annotations land on the right line:

```yaml
      - uses: Conalh/PolicyMesh@v0.3.0
        with:
          fail-on: none
          recursive: true
```

### Local diff: working tree vs a git ref

```powershell
node dist/index.js diff --base-ref main --repo .
```

`policymesh diff --base-ref <ref>` checks out the named ref into a temporary git worktree, audits it, audits the current working tree, and prints the delta — same engine the Action uses. Use this to see what your in-progress changes would surface on a PR before you push.

If you'd rather compose the primitives yourself:

```powershell
node dist/index.js audit --repo /path/to/base --format json > base.json
node dist/index.js audit --repo /path/to/head --format json > head.json
node dist/index.js diff --base-report base.json --head-report head.json --format github
```
Missing-server findings emit annotations on configured surfaces that are missing MCP servers, not only on the surface where the server is defined.
For subdirectory audits using the `repo` input, GitHub annotation file paths are prefixed back to the workflow workspace so warnings point at the checked-out files.

Start with `fail-on: none` so PolicyMesh is advisory while you tune policy. Raise it to `high` or `critical` once the findings are trusted.

Action outputs:

- `rating`: `none`, `low`, `medium`, `high`, or `critical`
- `finding-count`: total findings in the audit
- `surface-count`: number of configured agent policy surfaces found

## Current Findings

PolicyMesh v0 detects:

- MCP server command mismatches across MCP config files.
- MCP servers present in one MCP config but missing from another.
- MCP servers missing from configured MCP surfaces with empty server maps.
- MCP server enabled/disabled drift across surfaces.
- MCP server environment drift across surfaces without reporting secret values.
- MCP remote header drift across surfaces without reporting secret values.
- Codeium MCP servers from `.codeium/mcp_config.json` and Windsurf MCP servers from `.codeium/windsurf/mcp_config.json` in the same MCP mismatch, missing-server, enabled-state, env, and header checks.
- Codex MCP servers from `.codex/config.toml` in the same MCP mismatch, missing-server, enabled-state, env, and header checks.
- Unpinned MCP launch commands such as `@latest`.
- Claude broad allow rules overlapping with specific deny rules.
- Broad Claude allow rules without a `PreToolUse` guard hook.
- Claude MCP grants for servers missing from MCP configs.
- Codex network access enabled alongside other configured or unreadable agent surfaces.
- Codex trusted project settings combined with risky MCP configuration.
- Codex sandbox posture gaps relative to Claude deny rules.
- Hardcoded API credentials embedded in MCP launch commands, environment variable values, or headers (CRITICAL). The finding names the provider and the field it appeared in; the literal credential is never echoed in any output format.
- MCP servers referencing local scripts (relative paths ending in `.js`, `.py`, `.sh`, etc.) that do not exist in the checked-out repository.
- MCP servers launching via elevation utilities (`sudo`, `doas`, `pkexec`, `runas`, `gsudo`, etc.). Agents should run in user space, not as root.
- Aider configured with `dangerously-allow-non-git: true`, bypassing the git-tracked audit trail that makes edits reviewable.
- Risky imperatives in instruction files (`AGENTS.md`, `CLAUDE.md`, `.cursor/rules/*.md`, `.github/copilot-instructions.md`): "ignore deny rules" (HIGH), "without asking" (MEDIUM), "edit any file" (MEDIUM), "auto-commit / push automatically" (LOW). Detection is narrow regex over imperative + risky-scope phrasing — phrases like "Always use TypeScript" and "Never use var" do not trip.
- Malformed JSON and Codex TOML agent config files that would otherwise hide a policy surface.

PolicyMesh parses VS Code and Cursor configs as JSONC — `//` line comments, `/* */` block comments, and trailing commas are all accepted, so the audit doesn't false-fail on real-world editor output. `isBroadAllow` distinguishes scoped grants like `WebFetch(domain:example.com)` and `mcp__github__get_issue` from bare or wildcarded grants; narrow grants are not flagged.

### Baseline exceptions

Drop a `.policymesh-exceptions.json` at the repo root to suppress known and documented findings without disabling rules globally:

```json
{
  "exceptions": [
    {
      "kind": "policy_mesh.mcp_enabled_mismatch",
      "subject": "my-custom-tool",
      "reason": "Intentionally disabled on Cursor while we evaluate a regression",
      "expiry": "2026-12-31"
    }
  ]
}
```

Matching findings (by `kind` + `subject`) are silently suppressed. Once `expiry` passes, the finding is surfaced again — downgraded to `low` and prefixed `[EXPIRED WHITELIST]` — so stale baselines stay visible instead of rotting silently.

For higher-assurance baselines, add a `signature` from the finding's audit output:

```json
{
  "exceptions": [
    {
      "kind": "policy_mesh.mcp_enabled_mismatch",
      "subject": "github",
      "signature": "a1b2c3d4e5f6a7b8",
      "reason": "Approved by @security; locked to the reviewed violation."
    }
  ]
}
```

Every finding in the audit JSON now carries a `signature` field — a 16-char hash over the subject, file, and normalized message. Copy that value into the exception. If the underlying violation later changes (e.g. someone rewrites the MCP command to run a different binary), the signature stops matching and the finding re-fires with a `[SIGNATURE MISMATCH]` prefix so it gets re-reviewed rather than silently riding a stale approval. Exceptions without a `signature` keep the v0.2.0 kind+subject-only behaviour.

## Complements ScopeTrail

Use both tools together:

- **[ScopeTrail](https://github.com/Conalh/ScopeTrail)** — did agent permissions **change** in this PR?
- **PolicyMesh** — do agent surfaces **agree** in this repo right now?

## Feedback Wanted

PolicyMesh is intentionally small right now. If a warning is noisy, open a
[false-positive report](https://github.com/Conalh/PolicyMesh/issues/new?template=false-positive.yml).
If your team uses another agent config surface, open a
[missing-surface request](https://github.com/Conalh/PolicyMesh/issues/new?template=missing-surface.yml).
If you're trying PolicyMesh across multiple repositories or want shared baselines,
exception ownership, or cross-repo reports, the [team pilot guide](docs/TEAM_PILOT.md)
walks through a concrete multi-repo trial path and the
[team feedback form](https://github.com/Conalh/PolicyMesh/issues/new?template=team-validation.yml)
collects results.

## Development

```powershell
npm install
npm run build
npm test
```

Shared parsing, locators, and the Finding schema live in [agent-gov-core](https://github.com/Conalh/agent-gov-core) — see its [CONTRIBUTING.md](https://github.com/Conalh/agent-gov-core/blob/main/CONTRIBUTING.md) before touching that library.
