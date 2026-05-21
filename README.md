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
- `.codeium/windsurf/mcp_config.json`
- `.claude/settings.json`
- `.codex/config.toml`
- Surface matrix, effective capability union, and conflict findings
- Terminal, Markdown, JSON, and line-level GitHub annotation output
- GitHub Action step summaries and PR-visible warnings

It is intentionally not a hosted scanner. The Action reads the checked-out repository, uploads nothing by default, and starts advisory with `fail-on: none`.

**ScopeTrail catches permission drift in PRs. PolicyMesh catches contradictory agent policies in the repo.**

## Part of an AI-agent governance suite

Four tools mapping orthogonal failure modes of AI-agent deployment:

- **[ScopeTrail](https://github.com/Conalh/ScopeTrail)** — config drift over time (PR-level).
- **PolicyMesh** *(this repo)* — policy contradictions across agent surfaces.
- **[CapabilityEcho](https://github.com/Conalh/CapabilityEcho)** — capability drift via code, not config.
- **[TaskBound](https://github.com/Conalh/TaskBound)** — scope creep after the agent runs.

The first three are preventive (static analysis of config and code). TaskBound is detective (behavioral, comparing stated intent vs. actual diff).

## Demo

Live demo PR: [Demo: cross-surface agent policy conflicts](https://github.com/Conalh/PolicyMesh/pull/1)

That PR intentionally adds:

- The same `github` MCP server with different launch commands in `.mcp.json` and `.cursor/mcp.json`.
- An unpinned `@latest` MCP package in Cursor config.
- Broad Claude allow rules with a narrow `.env` deny and no `PreToolUse` hook.
- Codex network access and trusted project settings alongside the risky MCP setup.

PolicyMesh reports `HIGH` policy conflicts and emits GitHub warning annotations on the conflicting config lines.

Run PolicyMesh locally against the conflicted fixture:

```powershell
npm install
npm run build
node dist/index.js audit --repo test/fixtures/conflicted --format markdown
```

That fixture intentionally includes:

- The same `github` MCP server with different launch commands in `.mcp.json` and `.cursor/mcp.json`.
- VS Code and Codeium/Windsurf MCP configs participating in the same cross-surface mismatch.
- An unpinned `@latest` MCP package in Cursor config.
- Broad Claude allow rules with a narrow `.env` deny and no `PreToolUse` hook.
- Codex network access and trusted project settings alongside the risky MCP setup.

PolicyMesh reports `HIGH` policy conflicts and emits GitHub warning annotations on the conflicting config lines.

## Local Use

```powershell
npm install
npm run build
node dist/index.js audit --repo . --format markdown
```

JSON output:

```powershell
node dist/index.js audit --repo test/fixtures/conflicted --format json
```

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

      - uses: Conalh/PolicyMesh@v0.1.0
        with:
          fail-on: none
```

Unlike drift scanners, PolicyMesh audits the checked-out snapshot only. **No `fetch-depth: 0` is required.**

The action uploads nothing by default. It writes a Markdown report to the GitHub Actions step summary and emits PR-visible warning annotations for each finding.

Start with `fail-on: none` so PolicyMesh is advisory while you tune policy. Raise it to `high` or `critical` once the findings are trusted.

Action outputs:

- `rating`: `none`, `low`, `medium`, `high`, or `critical`
- `finding-count`: total findings in the audit
- `surface-count`: number of configured agent policy surfaces found

## Current Findings

PolicyMesh v0 detects:

- MCP server command mismatches across MCP config files.
- MCP servers present in one MCP config but missing from another.
- Unpinned MCP launch commands such as `@latest`.
- Claude broad allow rules overlapping with specific deny rules.
- Broad Claude allow rules without a `PreToolUse` guard hook.
- Codex network access enabled alongside other agent surfaces.
- Codex trusted project settings combined with risky MCP configuration.
- Codex sandbox posture gaps relative to Claude deny rules.
- Malformed JSON agent config files that would otherwise hide a policy surface.

PolicyMesh parses VS Code and Cursor configs as JSONC — `//` line comments, `/* */` block comments, and trailing commas are all accepted, so the audit doesn't false-fail on real-world editor output. `isBroadAllow` distinguishes scoped grants like `WebFetch(domain:example.com)` and `mcp__github__get_issue` from bare or wildcarded grants; narrow grants are not flagged.

## Complements ScopeTrail

Use both tools together:

- **[ScopeTrail](https://github.com/Conalh/ScopeTrail)** — did agent permissions **change** in this PR?
- **PolicyMesh** — do agent surfaces **agree** in this repo right now?

## Feedback Wanted

PolicyMesh is intentionally small right now. If a warning is noisy, open a
[false-positive report](https://github.com/Conalh/PolicyMesh/issues/new?template=false-positive.yml).
If your team uses another agent config surface, open a
[missing-surface request](https://github.com/Conalh/PolicyMesh/issues/new?template=missing-surface.yml).
If your team is testing PolicyMesh across multiple repositories or needs org-level
policy review, open a
[team validation signal](https://github.com/Conalh/PolicyMesh/issues/new?template=team-validation.yml).

## Development

```powershell
npm install
npm run build
npm test
```
