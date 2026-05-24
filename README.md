# PolicyMesh

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Language: TypeScript](https://img.shields.io/badge/language-TypeScript-3178c6.svg)](https://www.typescriptlang.org/)
[![Local-only](https://img.shields.io/badge/local--only-uploads%20nothing-2ea44f.svg)](#how-it-works)
[![Release](https://img.shields.io/github/v/release/Conalh/PolicyMesh)](https://github.com/Conalh/PolicyMesh/releases)

**Audits an AI-agent repo for contradictory configuration across MCP, Claude, Cursor, VS Code, Windsurf, Codex, and Aider — so one surface can't quietly override the rules another surface enforces.**

## The problem

Agent configuration is scattered. `.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.claude/settings.json`, `.codex/config.toml` and friends each describe what the agent is allowed to do, and they routinely disagree — same MCP server with different launch commands, broad Claude allow rules with a narrow deny that doesn't cover them, Codex network access enabled next to a workspace-write sandbox. Reviewers see one file at a time in a PR and miss the cross-surface contradiction. PolicyMesh reads every surface in the checked-out repo and reports where they don't line up.

## Quickstart

### As a GitHub Action (most common)

```yaml
name: PolicyMesh
on: pull_request
permissions:
  contents: read

jobs:
  policymesh:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
        with:
          fetch-depth: 0     # required for diff mode
      - uses: Conalh/PolicyMesh@v0.5.0
        with:
          fail-on: high
          diff: true         # gate only on findings this PR introduces or worsens
```

Writes a Markdown report to the Actions step summary and emits PR-visible `::warning` annotations on the exact conflicting config lines.

### Local CLI

```bash
git clone https://github.com/Conalh/PolicyMesh
cd PolicyMesh
npm install
npm run build

# Audit the bundled conflicted fixture
node dist/index.js audit --repo test/fixtures/conflicted --format markdown

# Or audit a real repo
node dist/index.js audit --repo /path/to/your/repo --format text
```

## Example output

Real output from `test/fixtures/conflicted`, `--format text`:

```
PolicyMesh agent policy review: HIGH

Effective capability union:
- 1 MCP server configured
- 3 unpinned MCP packages
- bash wildcards allowed (Claude)
- broad read paths allowed (Claude)
- network enabled (Codex)
- Codex project trusted
- Codex sandbox: workspace-write
- Strictest: Claude (1 sensitive deny rule) · Loosest: Codex (trusted + network)

[HIGH]   github: MCP server "github" has different launch commands across surfaces:
         "npx -y @modelcontextprotocol/server-github@1.2.3" vs "@latest" vs "@2.0.0".
         Surfaces: Root MCP, Cursor MCP, VS Code MCP, Windsurf MCP, Codex.
[MEDIUM] github: unpinned command across 3 surfaces (@latest). Surfaces: Cursor, VS Code, Windsurf.
[MEDIUM] Read(.env): Claude denies Read(.env) but has broad allow rules Bash(npm *), Read(~/**).
[MEDIUM] network_access: Codex network access enabled alongside other configured surfaces.
[HIGH]   github: Codex project trusted while MCP servers are unpinned and inconsistent.
```

`--format json` emits the canonical [agent-gov-core](https://github.com/Conalh/agent-gov-core) `Report` envelope — the same shape every tool in the suite emits, so [GovVerdict](https://github.com/Conalh/GovVerdict) can merge them:

```json
{
  "schemaVersion": "1.0",
  "tool": "policy_mesh",
  "rating": "high",
  "findings": [
    {
      "tool": "policy_mesh",
      "kind": "policy_mesh.mcp_command_mismatch",
      "severity": "high",
      "message": "MCP server \"github\" has different launch commands across surfaces…",
      "location": { "file": ".mcp.json", "line": 3 },
      "salientKey": "github",
      "data": {
        "subject": "github",
        "recommendation": "Use the same pinned MCP server definition in every MCP config file.",
        "surfaces": ["root_mcp", "cursor_mcp", "vscode_mcp", "windsurf_mcp", "codex"],
        "signature": "d0bb4972fd9e855d"
      },
      "fingerprint": "ce65620cb8140af3"
    }
  ]
}
```

`--format sarif` is also supported for the GitHub Security tab and other SAST consumers.

<!-- TODO: add screenshot or asciinema GIF of real output here -->

## How it works

- Runs against the **checked-out repo** — no upload, no hosted scanner, no telemetry. The GitHub Action writes a Markdown report to the step summary and emits PR-visible annotations; pass `github-token` to additionally post a sticky PR comment that updates in place.
- One audit pass renders five output formats: `text` for terminals, `markdown` for step summaries and PR comments, `json` for piping to GovVerdict, `github` for `::warning` annotations on the exact conflicting line, `sarif` for the GitHub Security tab.
- Detectors group by canonical identity (e.g. MCP command normalization ignores neutral flag reordering / `-y` vs `--yes` / `.cmd` vs `.exe`) and fire only when two or more surfaces actually disagree.
- **Diff mode** (`diff: true`) audits the PR base in a temporary worktree, audits HEAD, and gates only on **new or worsened** findings — so a PR doesn't fail on pre-existing conflicts. Findings resolved by the PR are surfaced separately as green-check signal.
- **`fix` / `fix pin`** can auto-align MCP enabled-state or `command` / `args` drift to a canonical surface you nominate. Always dry-run first; `--write` does line-targeted edits that preserve comments and indentation.
- **Baselines.** `.policymesh-exceptions.json` suppresses known-and-documented findings (optionally locked to a content signature so the suppression breaks if the violation later changes). `.policymesh-baseline.json` encodes the positive state the team requires and fires HIGH on drift.

## Options

### CLI

| Command | What it does |
| --- | --- |
| `policymesh audit --repo <path>` | Full repo audit. `--format text\|markdown\|json\|github\|sarif`. `--recursive` for monorepos. |
| `policymesh diff --base-ref <git-ref>` | Audit a base ref in a temp worktree, audit working tree, print the delta. |
| `policymesh diff --base-report a.json --head-report b.json` | Diff two saved JSON audits. |
| `policymesh fix --canonical <surface> [--write]` | Align MCP enabled / disabled state to a canonical surface. |
| `policymesh fix pin --canonical <surface> [--write]` | Align MCP `command` / `args` to a canonical surface. |
| `policymesh render --input <json> --format <fmt>` | Re-render a saved audit in another format. |

`<surface>` is one of: `root_mcp`, `cursor_mcp`, `vscode_mcp`, `codeium_mcp`, `windsurf_mcp`, `claude`, `codex`, `aider`, `instructions`.

### GitHub Action inputs

| Input | Default | Purpose |
| --- | --- | --- |
| `repo` | `$GITHUB_WORKSPACE` | Checkout path to inspect. |
| `fail-on` | `none` | Severity that fails the step: `none`, `low`, `medium`, `high`, `critical`. Start advisory, raise later. |
| `diff` | `false` | On `pull_request`, gate only on findings introduced or worsened by this PR. |
| `recursive` | `false` | Monorepo mode — audit every sub-project with its own agent config independently. |
| `github-token` | _(unset)_ | Optional `GITHUB_TOKEN` with `pull-requests: write` to post a sticky PR comment that updates in place. |

### GitHub Action outputs

`rating` (`none`/`low`/`medium`/`high`/`critical`), `finding-count`, `surface-count`.

## Detection coverage

PolicyMesh v0.5 detects MCP command mismatches, missing-server gaps, enabled-state drift, env / header drift (without echoing secret values), unpinned `@latest` packages, hardcoded API credentials in MCP launch lines, MCP servers launched via elevation utilities (`sudo`, `pkexec`, `runas`…), broken local script paths, Claude broad-allow vs narrow-deny contradictions, Claude broad allows without a `PreToolUse` hook, Claude MCP grants for servers that aren't configured, Codex network-access + trusted-project + risky-MCP combinations, Codex sandbox gaps relative to Claude denies, Aider `dangerously-allow-non-git`, and risky imperatives in `AGENTS.md` / `CLAUDE.md` / `.cursor/rules/*.md` / `.github/copilot-instructions.md` (e.g. "ignore deny rules", "edit any file", "auto-commit"). VS Code and Cursor configs are parsed as JSONC (comments and trailing commas accepted).

## Part of the agent-gov suite

Local-only OSS tools that review AI-agent PRs and coding sessions for config drift, policy mismatches, and scope creep. Each tool covers an orthogonal failure mode; they share a canonical `Finding` schema and can be merged into a single verdict.

| Repo | What it catches |
| --- | --- |
| **[ScopeTrail](https://github.com/Conalh/ScopeTrail)** | Diffs agent config files between PR base and head — permission drift. |
| **PolicyMesh** *(this repo)* | Audits MCP / Claude / Codex configs for contradictions across surfaces. |
| **[CapabilityEcho](https://github.com/Conalh/CapabilityEcho)** | Network, subprocess, eval, lifecycle, and workflow-permission signals in code diffs. |
| **[TaskBound](https://github.com/Conalh/TaskBound)** | Compares the stated task to the actual diff — scope creep. |
| **[SessionTrail](https://github.com/Conalh/SessionTrail)** | Parses Cursor / Claude / Codex JSONL session transcripts for runtime behavior. |
| **[GovVerdict](https://github.com/Conalh/GovVerdict)** | Merges JSON reports from the tools above into a single verdict. |
| **[agent-gov-core](https://github.com/Conalh/agent-gov-core)** | Shared parsers, the canonical `Finding` schema, `mergeFindings`. |
| **[agent-gov-demo](https://github.com/Conalh/agent-gov-demo)** | Sandbox repo with a rogue PR that exercises all five tools end-to-end. |

**Demo PR exercising the full stack:** [agent-gov-demo#1](https://github.com/Conalh/agent-gov-demo/pull/1)

---

MIT. Bug reports and false-positive reports welcome via [Issues](https://github.com/Conalh/PolicyMesh/issues).
