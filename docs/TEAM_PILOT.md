# PolicyMesh Team Pilot

Use this when a team wants to try PolicyMesh across multiple repositories and report back on whether the Action covers the team's real workflow needs.

## Pilot Setup

Run across at least two repositories that use AI-agent configuration in normal pull requests. Start advisory so the pilot measures signal quality without blocking developers.

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

      - uses: Conalh/PolicyMesh@v0.5.2
        with:
          fail-on: none
```

Keep the workflow unchanged for the first pass unless the repository needs the `repo` input for a subdirectory audit.

## What To Record

For each repository, record:

- Active surfaces: root MCP, Cursor MCP, VS Code MCP, Codeium MCP, Windsurf MCP, Claude settings, Codex settings, and Codex MCP tables.
- Finding counts by severity from the Action summary.
- Whether annotations point at the file and line the team would actually review.
- Whether each warning is actionable, noisy, or missing important context.
- Whether advisory mode is enough or a stricter `fail-on` threshold would be used after tuning.

## Team Workflow Gaps Worth Reporting

Single warnings rarely tell the whole story. The shape of team feedback most worth surfacing:

- shared baselines or defaults that multiple repositories should inherit;
- central severity policy that cannot be managed in each repo workflow;
- exception ownership, expiry, approval, or review history;
- cross-repo reports or audit exports;
- a blocker that prevents trying PolicyMesh in pull requests even with `fail-on: none`.

## Report Back

Open a [team feedback form](https://github.com/Conalh/PolicyMesh/issues/new?template=team-validation.yml) with the repository count, active surfaces, finding patterns, and any team-workflow gap.
