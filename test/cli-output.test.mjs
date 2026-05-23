import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { copyFile, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testDir, '..');

test('CLI aligned fixture returns none rating', async () => {
  const repo = join(testDir, 'fixtures', 'aligned');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.rating, 'none');
  assert.equal(report.findingCount, 0);
  assert.equal(report.surfaceCount, 6);
  assert.ok(report.effectiveUnion.length > 0);
  assert.ok(report.matrix.length > 0);
});

test('CLI repository root self-audit returns none rating', async () => {
  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', packageRoot, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.rating, 'none');
  assert.equal(report.findingCount, 0);
});

test('CLI rejects missing repository path instead of reporting a clean audit', async () => {
  const missingRepo = join(testDir, 'fixtures', 'does-not-exist');

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ['dist/index.js', 'audit', '--repo', missingRepo, '--format', 'json'],
      { cwd: packageRoot }
    ),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /Repository path does not exist/);
      assert.match(error.stderr, /does-not-exist/);
      assert.equal(error.stdout, '');
      return true;
    }
  );
});

test('CLI rejects file repository path instead of reporting a clean audit', async () => {
  const fileRepo = join(packageRoot, 'package.json');

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ['dist/index.js', 'audit', '--repo', fileRepo, '--format', 'json'],
      { cwd: packageRoot }
    ),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /Repository path is not a directory/);
      assert.match(error.stderr, /package\.json/);
      assert.equal(error.stdout, '');
      return true;
    }
  );
});

test('CLI rejects --repo without a value', async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ['dist/index.js', 'audit', '--repo'],
      { cwd: packageRoot }
    ),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /Missing value for --repo/);
      assert.match(error.stderr, /Usage: policymesh audit/);
      assert.equal(error.stdout, '');
      return true;
    }
  );
});

test('CLI rejects --repo before another option as a missing value', async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ['dist/index.js', 'audit', '--repo', '--format', 'json'],
      { cwd: packageRoot }
    ),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /Missing value for --repo/);
      assert.equal(error.stdout, '');
      return true;
    }
  );
});

test('CLI consolidates mcp_unpinned across surfaces into one finding with multiple locations', async () => {
  // Conflicted fixture has the same @latest github server pinned across
  // cursor / vscode / windsurf. Before consolidation this produced three
  // separate findings; now it should produce one with three locations,
  // matching the existing detectMcpCommandMismatch shape.
  const repo = join(testDir, 'fixtures', 'conflicted');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  const unpinned = report.findings.filter(
    (finding) => finding.kind === 'policy_mesh.mcp_unpinned'
  );
  assert.equal(unpinned.length, 1, 'expected exactly one consolidated mcp_unpinned finding');
  assert.ok(unpinned[0].locations.length >= 2, 'expected multiple locations on the consolidated finding');
  // Each location keeps its own surface tag so CI annotations still land
  // on every offending file.
  const surfaces = new Set(unpinned[0].locations.map((location) => location.surface));
  assert.ok(surfaces.size >= 2, 'expected locations to span multiple surfaces');
});

test('CLI conflicted fixture returns high rating with expected kinds', async () => {
  const repo = join(testDir, 'fixtures', 'conflicted');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.rating, 'high');
  assert.ok(report.findingCount >= 5);

  const kinds = report.findings.map((finding) => finding.kind);
  assert.ok(kinds.includes('policy_mesh.mcp_command_mismatch'));
  assert.ok(kinds.includes('policy_mesh.mcp_unpinned'));
  assert.ok(kinds.includes('policy_mesh.claude_deny_allow_overlap'));
  assert.ok(kinds.includes('policy_mesh.claude_broad_allow_no_guard'));
  assert.ok(kinds.includes('policy_mesh.codex_network_without_review'));
  assert.ok(kinds.includes('policy_mesh.codex_trusted_with_risky_mcp'));
  assert.ok(kinds.includes('policy_mesh.codex_claude_posture_gap'));

  const githubMismatch = report.findings.find(
    (finding) => finding.kind === 'policy_mesh.mcp_command_mismatch' && finding.subject === 'github'
  );
  assert.ok(githubMismatch);
  assert.ok(githubMismatch.surfaces.includes('codex'));
  assert.ok(githubMismatch.locations.some((location) => location.file === '.codex/config.toml' && location.surface === 'codex'));
});

test('CLI reports malformed agent config instead of crashing', async () => {
  const repo = join(testDir, 'fixtures', 'malformed');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.rating, 'high');
  assert.equal(report.findingCount, 1);
  assert.equal(report.surfaceCount, 1);
  assert.ok(report.effectiveUnion.includes('1 unreadable agent config'));
  assert.equal(report.findings[0].kind, 'policy_mesh.config_parse_error');
  assert.equal(report.findings[0].file, '.cursor/mcp.json');
  assert.match(report.findings[0].message, /Could not parse Cursor MCP config/);
});

test('CLI reports malformed Codex config instead of hiding the surface', async () => {
  const repo = join(testDir, 'fixtures', 'malformed-codex');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.rating, 'high');
  assert.equal(report.findingCount, 1);
  assert.equal(report.surfaceCount, 1);
  assert.ok(report.effectiveUnion.includes('1 unreadable agent config'));
  assert.equal(report.findings[0].kind, 'policy_mesh.config_parse_error');
  assert.equal(report.findings[0].file, '.codex/config.toml');
  assert.equal(report.findings[0].line, 1);
  assert.match(report.findings[0].message, /Could not parse Codex config/);
  assert.match(report.findings[0].recommendation, /TOML/);
});

test('CLI reports Claude MCP grants whose server is not defined in MCP configs', async () => {
  const repo = join(testDir, 'fixtures', 'claude-missing-mcp-server');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.rating, 'medium');
  assert.equal(report.findingCount, 1);
  assert.equal(report.surfaceCount, 2);
  assert.equal(report.findings[0].kind, 'policy_mesh.claude_mcp_grant_missing_server');
  assert.equal(report.findings[0].severity, 'medium');
  assert.equal(report.findings[0].file, '.claude/settings.json');
  assert.equal(report.findings[0].line, 4);
  assert.equal(report.findings[0].subject, 'mcp__github__get_issue');
  assert.deepEqual(report.findings[0].surfaces, ['claude', 'root_mcp']);
  assert.match(report.findings[0].message, /github/);
  assert.match(report.findings[0].recommendation, /MCP config/);
});

test('CLI reports servers missing from configured but empty MCP surfaces', async () => {
  const repo = join(testDir, 'fixtures', 'empty-mcp-surface');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.rating, 'low');
  assert.equal(report.findingCount, 1);
  assert.equal(report.surfaceCount, 2);
  assert.equal(report.findings[0].kind, 'policy_mesh.mcp_server_missing');
  assert.equal(report.findings[0].severity, 'low');
  assert.equal(report.findings[0].subject, 'github');
  assert.deepEqual(report.findings[0].surfaces, ['root_mcp', 'cursor_mcp']);
  assert.match(report.findings[0].message, /defined in Root MCP/);
  assert.match(report.findings[0].message, /missing from Cursor MCP/);
  assert.doesNotMatch(report.findings[0].message, /root_mcp|cursor_mcp/);
});

test('CLI reports MCP server enabled-state drift across surfaces', async () => {
  const repo = join(testDir, 'fixtures', 'mcp-enabled-mismatch');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.rating, 'medium');
  assert.equal(report.findingCount, 1);
  assert.equal(report.surfaceCount, 2);
  assert.equal(report.findings[0].kind, 'policy_mesh.mcp_enabled_mismatch');
  assert.equal(report.findings[0].severity, 'medium');
  assert.equal(report.findings[0].subject, 'github');
  assert.deepEqual(report.findings[0].surfaces, ['root_mcp', 'cursor_mcp']);
  assert.match(report.findings[0].message, /enabled in Root MCP/);
  assert.match(report.findings[0].message, /disabled in Cursor MCP/);
  assert.doesNotMatch(report.findings[0].message, /root_mcp|cursor_mcp/);
});

test('CLI reports MCP server environment drift without leaking values', async () => {
  const repo = join(testDir, 'fixtures', 'mcp-env-mismatch');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.rating, 'medium');
  assert.equal(report.findingCount, 1);
  assert.equal(report.surfaceCount, 2);
  assert.equal(report.findings[0].kind, 'policy_mesh.mcp_env_mismatch');
  assert.equal(report.findings[0].severity, 'medium');
  assert.equal(report.findings[0].subject, 'github');
  assert.deepEqual(report.findings[0].surfaces, ['root_mcp', 'vscode_mcp']);
  assert.match(report.findings[0].message, /environment variable names differ/);
  assert.match(report.findings[0].message, /Root MCP uses GITHUB_TOKEN/);
  assert.match(report.findings[0].message, /VS Code MCP uses GH_TOKEN/);
  assert.doesNotMatch(report.findings[0].message, /root_mcp|vscode_mcp/);
  assert.doesNotMatch(stdout, /root-token-value/);
  assert.doesNotMatch(stdout, /vscode-token-value/);
});

test('CLI reports only differing MCP environment value keys without leaking values', async () => {
  const repo = join(testDir, 'fixtures', 'mcp-env-value-mismatch');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.rating, 'medium');
  assert.equal(report.findingCount, 1);
  assert.equal(report.surfaceCount, 2);
  assert.equal(report.findings[0].kind, 'policy_mesh.mcp_env_mismatch');
  assert.match(report.findings[0].message, /environment values differ/);
  assert.match(report.findings[0].message, /GITHUB_TOKEN/);
  assert.doesNotMatch(report.findings[0].message, /SHARED_TIMEOUT/);
  assert.doesNotMatch(stdout, /root-token-value/);
  assert.doesNotMatch(stdout, /cursor-token-value/);
});

test('CLI reports MCP server header drift without leaking values', async () => {
  const repo = join(testDir, 'fixtures', 'mcp-header-mismatch');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.rating, 'medium');
  assert.equal(report.findingCount, 1);
  assert.equal(report.surfaceCount, 2);
  assert.equal(report.findings[0].kind, 'policy_mesh.mcp_header_mismatch');
  assert.equal(report.findings[0].severity, 'medium');
  assert.equal(report.findings[0].subject, 'analytics');
  assert.deepEqual(report.findings[0].surfaces, ['root_mcp', 'vscode_mcp']);
  assert.match(report.findings[0].message, /header names differ/);
  assert.match(report.findings[0].message, /Root MCP uses Authorization/);
  assert.match(report.findings[0].message, /VS Code MCP uses X-API-Key/);
  assert.doesNotMatch(report.findings[0].message, /root_mcp|vscode_mcp/);
  assert.doesNotMatch(stdout, /root-header-secret/);
  assert.doesNotMatch(stdout, /vscode-header-secret/);
});

test('CLI reports Codex MCP server command drift against root MCP config', async () => {
  const repo = join(testDir, 'fixtures', 'codex-mcp-command-mismatch');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.rating, 'high');
  assert.equal(report.findingCount, 1);
  assert.equal(report.surfaceCount, 2);
  assert.equal(report.findings[0].kind, 'policy_mesh.mcp_command_mismatch');
  assert.equal(report.findings[0].subject, 'github');
  assert.deepEqual(report.findings[0].surfaces, ['root_mcp', 'codex']);
  assert.ok(report.findings[0].locations.some((location) => location.file === '.codex/config.toml' && location.surface === 'codex'));
  // Matrix cells now show short semantic labels: a pinned version
  // for each surface so reviewers can scan a column for drift.
  assert.ok(report.matrix.some((row) =>
    row.capability === 'MCP: github' && row.values.codex === 'v2.0.0' && row.values.root_mcp === 'v1.2.3'
  ));
});

test('CLI parses multi-line Codex TOML args without producing false-positive mismatch', async () => {
  // Regression for parseTomlEntries' line-by-line value reader.
  // Root MCP and Codex declare identical github invocations, but Codex
  // writes the args array across multiple lines. Pre-fix, the parser
  // saw only `args = [`, lost the rest, and produced a high-severity
  // mcp_command_mismatch finding because canonicalIdentity drifted.
  const repo = join(testDir, 'fixtures', 'codex-multiline-args');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  const mismatch = report.findings.filter(
    (finding) => finding.kind === 'policy_mesh.mcp_command_mismatch'
  );
  assert.deepEqual(mismatch, [], 'expected no mcp_command_mismatch findings');
  assert.equal(report.surfaceCount, 2);
  // Both surfaces should expose a github MCP server with the full pinned command.
  const githubRow = report.matrix.find((row) => row.capability === 'MCP: github');
  assert.ok(githubRow);
  assert.equal(githubRow.values.codex, 'v1.2.3');
  assert.equal(githubRow.values.root_mcp, 'v1.2.3');
});

test('CLI does not flag mcp_command_mismatch on neutral -y flag drift between surfaces', async () => {
  // Regression for the PolicyMesh audit's false-positive class:
  // root MCP uses `npx -y <pkg>`, Cursor uses `npx <pkg>`. `-y` only
  // suppresses npx's install prompt — it doesn't change what runs.
  // Pre-fix, this fixture produced a high-severity mcp_command_mismatch
  // because the detector grouped by the raw joined command string.
  // Post-fix, the detector groups by normalizeMcpCommand canonical
  // identity, which drops `-y`/`--yes`, so the surfaces are equivalent.
  const repo = join(testDir, 'fixtures', 'mcp-command-neutral-flag-equivalence');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  const mismatchFindings = report.findings.filter(
    (finding) => finding.kind === 'policy_mesh.mcp_command_mismatch'
  );
  assert.deepEqual(mismatchFindings, [], 'expected no mcp_command_mismatch findings');
  assert.equal(report.surfaceCount, 2);
});

test('CLI reports Codeium plugin MCP command drift against root MCP config', async () => {
  const repo = join(testDir, 'fixtures', 'codeium-plugin-mcp-config');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.rating, 'high');
  assert.equal(report.findingCount, 1);
  assert.equal(report.surfaceCount, 2);
  assert.equal(report.findings[0].kind, 'policy_mesh.mcp_command_mismatch');
  assert.equal(report.findings[0].subject, 'github');
  assert.deepEqual(report.findings[0].surfaces, ['root_mcp', 'codeium_mcp']);
  assert.ok(report.findings[0].locations.some((location) => location.file === '.codeium/mcp_config.json' && location.surface === 'codeium_mcp'));
  assert.ok(report.matrix.some((row) =>
    row.capability === 'MCP: github' && row.values.codeium_mcp === 'v2.0.0' && row.values.root_mcp === 'v1.2.3'
  ));
});

test('CLI reports only differing MCP header value keys without leaking values', async () => {
  const repo = join(testDir, 'fixtures', 'mcp-header-value-mismatch');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.rating, 'medium');
  assert.equal(report.findingCount, 1);
  assert.equal(report.surfaceCount, 2);
  assert.equal(report.findings[0].kind, 'policy_mesh.mcp_header_mismatch');
  assert.match(report.findings[0].message, /header values differ/);
  assert.match(report.findings[0].message, /Authorization/);
  assert.doesNotMatch(report.findings[0].message, /X-Org/);
  assert.doesNotMatch(stdout, /root-header-secret/);
  assert.doesNotMatch(stdout, /cursor-header-secret/);
});

test('CLI reports Codex network access alongside unreadable agent surfaces', async () => {
  const repo = join(testDir, 'fixtures', 'codex-network-unreadable-surface');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.rating, 'high');
  assert.equal(report.findingCount, 2);
  assert.equal(report.surfaceCount, 2);
  assert.equal(report.findings[0].kind, 'policy_mesh.config_parse_error');
  assert.equal(report.findings[0].file, '.cursor/mcp.json');
  assert.equal(report.findings[1].kind, 'policy_mesh.codex_network_without_review');
  assert.equal(report.findings[1].severity, 'medium');
  assert.equal(report.findings[1].file, '.codex/config.toml');
  assert.equal(report.findings[1].line, 1);
  assert.deepEqual(report.findings[1].surfaces, ['codex', 'cursor_mcp']);
});

test('CLI reports hardcoded secrets in MCP env without leaking the value', async () => {
  const repo = join(testDir, 'fixtures', 'mcp-hardcoded-secret');
  const secret = 'sk-proj-fakeFAKEfakeFAKEfakeFAKE0123456789ABCDEF';

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.rating, 'critical');
  const secretFindings = report.findings.filter(
    (finding) => finding.kind === 'policy_mesh.hardcoded_secret'
  );
  assert.equal(secretFindings.length, 1);
  assert.equal(secretFindings[0].severity, 'critical');
  assert.equal(secretFindings[0].subject, 'leaky-openai');
  assert.deepEqual(secretFindings[0].surfaces, ['root_mcp']);
  assert.match(secretFindings[0].message, /OpenAI/);
  assert.match(secretFindings[0].message, /OPENAI_API_KEY/);
  assert.match(secretFindings[0].recommendation, /environment-variable reference/);

  // The safe `env:VAR` server must not be flagged.
  assert.equal(
    secretFindings.some((finding) => finding.subject === 'safe-anthropic'),
    false
  );

  // The literal credential must never appear in any rendered output.
  assert.doesNotMatch(stdout, new RegExp(secret.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')));
});

test('CLI active exception in .policymesh-exceptions.json suppresses matching finding', async () => {
  const repo = join(testDir, 'fixtures', 'exceptions-active');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.rating, 'none');
  assert.equal(report.findingCount, 0);
  assert.equal(report.surfaceCount, 2);
});

test('CLI expired exception surfaces finding with downgrade and EXPIRED prefix', async () => {
  const repo = join(testDir, 'fixtures', 'exceptions-expired');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.rating, 'low');
  assert.equal(report.findingCount, 1);
  assert.equal(report.findings[0].kind, 'policy_mesh.mcp_enabled_mismatch');
  assert.equal(report.findings[0].severity, 'low');
  assert.equal(report.findings[0].subject, 'github');
  assert.match(report.findings[0].message, /^\[EXPIRED WHITELIST\]/);
});

test('CLI reports MCP servers referencing missing local scripts', async () => {
  const repo = join(testDir, 'fixtures', 'mcp-missing-local-script');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  const scriptFindings = report.findings.filter(
    (finding) => finding.kind === 'policy_mesh.missing_local_script'
  );
  assert.equal(scriptFindings.length, 1);
  assert.equal(scriptFindings[0].severity, 'medium');
  assert.equal(scriptFindings[0].subject, 'broken-tool');
  assert.match(scriptFindings[0].message, /missing-tool\.js/);
  assert.deepEqual(scriptFindings[0].surfaces, ['root_mcp']);
  // Servers using a present file or a package name must NOT be flagged.
  assert.equal(scriptFindings.some((f) => f.subject === 'real-tool'), false);
  assert.equal(scriptFindings.some((f) => f.subject === 'package-tool'), false);
});

test('CLI reports Aider dangerously-allow-non-git as a high-severity finding', async () => {
  const repo = join(testDir, 'fixtures', 'aider-dangerous-non-git');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.rating, 'high');
  assert.equal(report.surfaceCount, 1);
  const aiderFindings = report.findings.filter(
    (finding) => finding.kind === 'policy_mesh.aider_dangerous_allow_non_git'
  );
  assert.equal(aiderFindings.length, 1);
  assert.equal(aiderFindings[0].severity, 'high');
  assert.equal(aiderFindings[0].file, '.aider.conf.yml');
  assert.equal(aiderFindings[0].line, 4);
  assert.deepEqual(aiderFindings[0].surfaces, ['aider']);

  // Matrix should expose Aider settings without leaking model strings into Codex columns etc.
  const modelRow = report.matrix.find((row) => row.capability === 'Aider model');
  assert.ok(modelRow);
  assert.equal(modelRow.values.aider, 'claude-3-5-sonnet');
});

test('CLI does not flag Aider when dangerously-allow-non-git is false', async () => {
  const repo = join(testDir, 'fixtures', 'aider-safe');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  assert.equal(report.rating, 'none');
  assert.equal(report.surfaceCount, 1);
  assert.equal(
    report.findings.some((f) => f.kind === 'policy_mesh.aider_dangerous_allow_non_git'),
    false
  );
});

test('CLI reports MCP servers launching via privileged commands', async () => {
  const repo = join(testDir, 'fixtures', 'mcp-privileged-command');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  const privilegedFindings = report.findings.filter(
    (finding) => finding.kind === 'policy_mesh.privileged_command'
  );
  assert.equal(privilegedFindings.length, 1);
  assert.equal(privilegedFindings[0].severity, 'high');
  assert.equal(privilegedFindings[0].subject, 'needs-root');
  assert.match(privilegedFindings[0].message, /"sudo"/);
  assert.deepEqual(privilegedFindings[0].surfaces, ['root_mcp']);
  assert.equal(privilegedFindings.some((f) => f.subject === 'user-space'), false);
});

test('CLI signature-locked exception re-fires when underlying violation changes', async () => {
  const repo = join(testDir, 'fixtures', 'exceptions-signature-mismatch');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  // The exception's signature is intentionally stale (0000...); the underlying
  // enabled-state mismatch has changed (versions diverged), so we expect the
  // finding to surface with the SIGNATURE MISMATCH prefix rather than be silenced.
  const enabledMismatch = report.findings.find(
    (finding) => finding.kind === 'policy_mesh.mcp_enabled_mismatch'
  );
  assert.ok(enabledMismatch, 'expected mcp_enabled_mismatch to fire despite the kind+subject match');
  assert.match(enabledMismatch.message, /^\[SIGNATURE MISMATCH\]/);
  // Every finding in the report now carries a signature so users can copy it.
  assert.match(enabledMismatch.signature, /^[a-f0-9]{16}$/);
});

test('CLI emits a signature on every finding so reviewers can lock baselines', async () => {
  const repo = join(testDir, 'fixtures', 'conflicted');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);
  for (const finding of report.findings) {
    assert.match(finding.signature, /^[a-f0-9]{16}$/, `finding ${finding.kind}/${finding.subject} should expose a signature`);
  }
});

test('CLI reports malformed .policymesh-exceptions.json instead of crashing', async () => {
  const repo = join(testDir, 'fixtures', 'exceptions-malformed');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  const parseFindings = report.findings.filter(
    (finding) => finding.kind === 'policy_mesh.exceptions_parse_error'
  );
  assert.equal(parseFindings.length, 1);
  assert.equal(parseFindings[0].severity, 'medium');
  assert.equal(parseFindings[0].file, '.policymesh-exceptions.json');
  assert.match(parseFindings[0].message, /Could not parse exceptions baseline/);
});

test('CLI text format emits ANSI colors when FORCE_COLOR is set', async () => {
  const repo = join(testDir, 'fixtures', 'conflicted');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'text'],
    { cwd: packageRoot, env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: undefined } }
  );

  const esc = String.fromCharCode(0x1b);
  assert.ok(stdout.includes(esc), 'expected ANSI escape bytes when FORCE_COLOR=1');
  assert.ok(stdout.includes(`${esc}[91m`) || stdout.includes(`${esc}[31m`), 'expected red/bright-red for high+ findings');
});

test('CLI text format respects NO_COLOR even with FORCE_COLOR set', async () => {
  const repo = join(testDir, 'fixtures', 'conflicted');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'text'],
    { cwd: packageRoot, env: { ...process.env, FORCE_COLOR: '1', NO_COLOR: '1' } }
  );

  const esc = String.fromCharCode(0x1b);
  assert.equal(stdout.includes(esc), false, 'NO_COLOR must suppress ANSI escapes');
});

test('CLI text format produces no ANSI when stdout is not a TTY and FORCE_COLOR is unset', async () => {
  const repo = join(testDir, 'fixtures', 'aligned');
  const childEnv = { ...process.env };
  delete childEnv.FORCE_COLOR;
  delete childEnv.NO_COLOR;

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'text'],
    { cwd: packageRoot, env: childEnv }
  );

  const esc = String.fromCharCode(0x1b);
  assert.equal(stdout.includes(esc), false, 'no ANSI when stdout is piped and no FORCE_COLOR');
});

test('CLI --recursive discovers and audits sibling sub-projects independently', async () => {
  const repo = join(testDir, 'fixtures', 'monorepo-basic');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--recursive', '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  // Only apps/api uses @latest, so only its finding should fire.
  const unpinned = report.findings.filter(
    (finding) => finding.kind === 'policy_mesh.mcp_unpinned'
  );
  assert.equal(unpinned.length, 1);
  assert.match(unpinned[0].file, /apps[\/\\]api[\/\\]\.mcp\.json/);
  assert.equal(report.rating, 'medium');

  // Surface matrix rows are tagged with the sub-project path so identical
  // capabilities from different projects do not collide.
  const githubRows = report.matrix.filter((row) => row.capability.startsWith('MCP: github'));
  assert.equal(githubRows.length, 2);
  assert.ok(githubRows.some((row) => row.capability.includes('apps/web')));
  assert.ok(githubRows.some((row) => row.capability.includes('apps/api')));

  // Each sub-project contributes one MCP surface, so the count sums.
  assert.equal(report.surfaceCount, 2);
});

test('CLI without --recursive on a monorepo audits only the root', async () => {
  const repo = join(testDir, 'fixtures', 'monorepo-basic');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  // No root-level configs in the fixture, so the root audit finds nothing.
  assert.equal(report.findingCount, 0);
  assert.equal(report.surfaceCount, 0);
});

async function copyFixture(srcDir, destDir) {
  await mkdir(destDir, { recursive: true });
  const { readdir, stat: statFn } = await import('node:fs/promises');
  for (const entry of await readdir(srcDir)) {
    const src = join(srcDir, entry);
    const dest = join(destDir, entry);
    const s = await statFn(src);
    if (s.isDirectory()) {
      await copyFixture(src, dest);
    } else {
      await copyFile(src, dest);
    }
  }
}

test('CLI diff --base-ref audits the named ref via git worktree and diffs against working tree', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'policymesh-diff-ref-'));
  try {
    const git = (...args) =>
      execFileAsync('git', ['-C', repo, ...args]);
    await git('init', '-b', 'main');
    await git('config', 'user.email', 'test@example.com');
    await git('config', 'user.name', 'Test');
    await git('config', 'commit.gpgsign', 'false');

    const aligned = `{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github@1.2.3"]
    }
  }
}
`;
    const { writeFile, mkdir } = await import('node:fs/promises');
    await writeFile(join(repo, '.mcp.json'), aligned);
    await mkdir(join(repo, '.cursor'), { recursive: true });
    await writeFile(join(repo, '.cursor', 'mcp.json'), aligned);
    await git('add', '.');
    await git('commit', '-m', 'aligned baseline');

    // Working-tree edit introduces a command mismatch versus the committed HEAD.
    const mismatched = `{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github@2.0.0"]
    }
  }
}
`;
    await writeFile(join(repo, '.cursor', 'mcp.json'), mismatched);

    const { stdout } = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'diff', '--base-ref', 'HEAD', '--repo', repo, '--format', 'json'],
      { cwd: packageRoot }
    );
    const delta = JSON.parse(stdout);

    assert.ok(delta.findingCount >= 1, 'expected at least one new finding from the working-tree mismatch');
    assert.ok(
      delta.findings.some((finding) => finding.kind === 'policy_mesh.mcp_command_mismatch'),
      'expected an mcp_command_mismatch finding in the delta'
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('CLI diff --base-ref rejects --head-ref other than HEAD in v1', async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ['dist/index.js', 'diff', '--base-ref', 'main', '--head-ref', 'feature/x', '--repo', packageRoot],
      { cwd: packageRoot }
    ),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--head-ref currently supports "HEAD" only/);
      return true;
    }
  );
});

test('CLI render reproduces audit output from saved JSON without re-running detectors', async () => {
  const repo = join(testDir, 'fixtures', 'conflicted');
  const jsonPath = join(await mkdtemp(join(tmpdir(), 'policymesh-render-')), 'report.json');

  try {
    const { stdout: jsonOut } = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
      { cwd: packageRoot }
    );
    await (await import('node:fs/promises')).writeFile(jsonPath, jsonOut, 'utf8');

    // render --format json round-trips identically.
    const rendered = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'render', '--input', jsonPath, '--format', 'json'],
      { cwd: packageRoot }
    );
    assert.equal(rendered.stdout, jsonOut);

    // render --format markdown produces the same markdown a direct audit would.
    const directMd = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'audit', '--repo', repo, '--format', 'markdown'],
      { cwd: packageRoot }
    );
    const renderedMd = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'render', '--input', jsonPath, '--format', 'markdown'],
      { cwd: packageRoot }
    );
    assert.equal(renderedMd.stdout, directMd.stdout);
  } finally {
    await rm(jsonPath, { force: true });
  }
});

test('CLI render --annotation-path-prefix prepends the prefix in github annotations', async () => {
  const repo = join(testDir, 'fixtures', 'conflicted');
  const tmp = await mkdtemp(join(tmpdir(), 'policymesh-render-'));
  const jsonPath = join(tmp, 'report.json');

  try {
    const { stdout: jsonOut } = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
      { cwd: packageRoot }
    );
    await (await import('node:fs/promises')).writeFile(jsonPath, jsonOut, 'utf8');

    const { stdout } = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'render', '--input', jsonPath, '--format', 'github', '--annotation-path-prefix', 'sub/repo'],
      { cwd: packageRoot }
    );

    assert.match(stdout, /^::warning file=sub\/repo\//m);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('CLI diff returns only findings introduced or worsened in head', async () => {
  // Use aligned vs conflicted as a stand-in for "before this PR vs after".
  // aligned has no findings; conflicted has 7 (post-consolidation).
  // The delta should be 7 net new findings.
  const tmp = await mkdtemp(join(tmpdir(), 'policymesh-diff-'));
  try {
    const baseJsonPath = join(tmp, 'base.json');
    const headJsonPath = join(tmp, 'head.json');

    const baseAudit = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'audit', '--repo', join(testDir, 'fixtures', 'aligned'), '--format', 'json'],
      { cwd: packageRoot }
    );
    const headAudit = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'audit', '--repo', join(testDir, 'fixtures', 'conflicted'), '--format', 'json'],
      { cwd: packageRoot }
    );
    const { writeFile } = await import('node:fs/promises');
    await writeFile(baseJsonPath, baseAudit.stdout, 'utf8');
    await writeFile(headJsonPath, headAudit.stdout, 'utf8');

    const { stdout } = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'diff', '--base-report', baseJsonPath, '--head-report', headJsonPath, '--format', 'json'],
      { cwd: packageRoot }
    );
    const delta = JSON.parse(stdout);

    assert.equal(delta.findingCount, 7, 'all conflicted findings are new relative to aligned');
    assert.equal(delta.rating, 'high');
    // Effective union and matrix still reflect head's full state for context.
    assert.ok(delta.matrix.length > 0);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('CLI diff renders Resolved by this PR section when base findings disappear in head', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'policymesh-diff-resolved-'));
  try {
    // base has conflicted findings; head is aligned (clean). Every base finding is resolved.
    const baseAudit = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'audit', '--repo', join(testDir, 'fixtures', 'conflicted'), '--format', 'json'],
      { cwd: packageRoot }
    );
    const headAudit = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'audit', '--repo', join(testDir, 'fixtures', 'aligned'), '--format', 'json'],
      { cwd: packageRoot }
    );
    const { writeFile } = await import('node:fs/promises');
    const basePath = join(tmp, 'base.json');
    const headPath = join(tmp, 'head.json');
    await writeFile(basePath, baseAudit.stdout, 'utf8');
    await writeFile(headPath, headAudit.stdout, 'utf8');

    const { stdout: jsonOut } = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'diff', '--base-report', basePath, '--head-report', headPath, '--format', 'json'],
      { cwd: packageRoot }
    );
    const delta = JSON.parse(jsonOut);
    assert.equal(delta.findingCount, 0);
    assert.ok(delta.resolvedFindings);
    assert.ok(delta.resolvedFindings.length >= 5);

    const { stdout: mdOut } = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'diff', '--base-report', basePath, '--head-report', headPath, '--format', 'markdown'],
      { cwd: packageRoot }
    );
    assert.match(mdOut, /## Resolved by this PR/);
    assert.match(mdOut, /This PR resolved \d+ pre-existing findings and introduced no new ones/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('CLI diff produces an empty delta when base and head match', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'policymesh-diff-'));
  try {
    const audit = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'audit', '--repo', join(testDir, 'fixtures', 'conflicted'), '--format', 'json'],
      { cwd: packageRoot }
    );
    const jsonPath = join(tmp, 'report.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(jsonPath, audit.stdout, 'utf8');

    const { stdout } = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'diff', '--base-report', jsonPath, '--head-report', jsonPath, '--format', 'json'],
      { cwd: packageRoot }
    );
    const delta = JSON.parse(stdout);

    assert.equal(delta.findingCount, 0);
    assert.equal(delta.rating, 'none');
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('CLI diff renders github annotations only for delta findings', async () => {
  const tmp = await mkdtemp(join(tmpdir(), 'policymesh-diff-'));
  try {
    const baseAudit = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'audit', '--repo', join(testDir, 'fixtures', 'aligned'), '--format', 'json'],
      { cwd: packageRoot }
    );
    const headAudit = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'audit', '--repo', join(testDir, 'fixtures', 'mcp-hardcoded-secret'), '--format', 'json'],
      { cwd: packageRoot }
    );
    const basePath = join(tmp, 'base.json');
    const headPath = join(tmp, 'head.json');
    const { writeFile } = await import('node:fs/promises');
    await writeFile(basePath, baseAudit.stdout, 'utf8');
    await writeFile(headPath, headAudit.stdout, 'utf8');

    const { stdout } = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'diff', '--base-report', basePath, '--head-report', headPath, '--format', 'github'],
      { cwd: packageRoot }
    );

    assert.match(stdout, /^::warning file=/m);
    assert.match(stdout, /PolicyMesh critical finding/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('CLI render rejects missing input file with a clear error', async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ['dist/index.js', 'render', '--input', '/nope/missing.json', '--format', 'json'],
      { cwd: packageRoot }
    ),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /Input report not found/);
      return true;
    }
  );
});

test('CLI fix dry-run lists planned enabled-state edits without modifying files', async () => {
  const repo = join(testDir, 'fixtures', 'fix-enabled-mismatch');
  const before = await readFile(join(repo, '.cursor', 'mcp.json'), 'utf8');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'fix', '--repo', repo, '--canonical', 'root_mcp'],
    { cwd: packageRoot }
  );

  assert.match(stdout, /Would apply 1 edit/);
  assert.match(stdout, /Align "github" enabled=true/);
  assert.match(stdout, /\.cursor[\/\\]mcp\.json/);

  // Source file is untouched.
  const after = await readFile(join(repo, '.cursor', 'mcp.json'), 'utf8');
  assert.equal(after, before);
});

test('CLI fix --write preserves comments and trailing commas (JSONC)', async () => {
  const src = join(testDir, 'fixtures', 'fix-preserves-comments');
  const repo = await mkdtemp(join(tmpdir(), 'policymesh-fix-jsonc-'));
  try {
    await copyFixture(src, repo);
    const cursorPath = join(repo, '.cursor', 'mcp.json');
    const before = await readFile(cursorPath, 'utf8');

    await execFileAsync(
      process.execPath,
      ['dist/index.js', 'fix', '--repo', repo, '--canonical', 'root_mcp', '--write'],
      { cwd: packageRoot }
    );

    const after = await readFile(cursorPath, 'utf8');

    // The disabled toggle flipped.
    assert.match(after, /"disabled":\s*false/);
    assert.doesNotMatch(after, /"disabled":\s*true/);

    // Comments survived.
    assert.match(after, /\/\/ GitHub MCP is intentionally turned off/);
    assert.match(after, /\/\* matches root's pin; only the toggle differs \*\//);

    // Trailing commas survived.
    assert.match(after, /"disabled":\s*false,/);
    assert.match(after, /},\s*\n\s*},\s*\n}\s*$/);

    // Nothing else changed about the file shape.
    const beforeStripped = before.replace(/"disabled":\s*true/, '');
    const afterStripped = after.replace(/"disabled":\s*false/, '');
    assert.equal(beforeStripped, afterStripped, 'only the boolean token should differ between before and after');
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('CLI fix --write applies the planned edits and aligns enabled state', async () => {
  const src = join(testDir, 'fixtures', 'fix-enabled-mismatch');
  const repo = await mkdtemp(join(tmpdir(), 'policymesh-fix-'));
  try {
    await copyFixture(src, repo);

    const { stdout } = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'fix', '--repo', repo, '--canonical', 'root_mcp', '--write'],
      { cwd: packageRoot }
    );

    assert.match(stdout, /Applied 1 edit\(s\)/);

    const updated = JSON.parse(await readFile(join(repo, '.cursor', 'mcp.json'), 'utf8'));
    // Cursor's `disabled` was rewritten to false (server is now active to match root).
    assert.equal(updated.mcpServers.github.disabled, false);

    // Running an audit on the rewritten tree should no longer flag enabled mismatch.
    const audit = await execFileAsync(
      process.execPath,
      ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
      { cwd: packageRoot }
    );
    const report = JSON.parse(audit.stdout);
    assert.equal(
      report.findings.some((f) => f.kind === 'policy_mesh.mcp_enabled_mismatch'),
      false
    );
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('CLI fix rejects missing or invalid --canonical', async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ['dist/index.js', 'fix', '--repo', join(testDir, 'fixtures', 'fix-enabled-mismatch')],
      { cwd: packageRoot }
    ),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /Missing required argument: --canonical/);
      return true;
    }
  );

  await assert.rejects(
    execFileAsync(
      process.execPath,
      ['dist/index.js', 'fix', '--repo', join(testDir, 'fixtures', 'fix-enabled-mismatch'), '--canonical', 'not-a-surface'],
      { cwd: packageRoot }
    ),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /--canonical must be one of/);
      return true;
    }
  );
});

test('CLI markdown adds a Conflicts subsection above the full matrix when surfaces disagree', async () => {
  const repo = join(testDir, 'fixtures', 'conflicted');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'markdown'],
    { cwd: packageRoot }
  );

  const conflictsHeader = stdout.indexOf('## Surface matrix — conflicts');
  const fullMatrixHeader = stdout.indexOf('## Surface matrix\n');
  assert.ok(conflictsHeader > 0, 'expected a conflicts subsection');
  assert.ok(fullMatrixHeader > conflictsHeader, 'conflicts subsection should precede the full matrix');
  // The conflicts subsection only shows the github row (the only one where surfaces disagree post-consolidation).
  const conflictsBlock = stdout.slice(conflictsHeader, fullMatrixHeader);
  assert.match(conflictsBlock, /MCP: github/);
  // Aligned rows (e.g. Hook entries with a single Claude value) should be in the full matrix only.
  assert.doesNotMatch(conflictsBlock, /Hook: PreToolUse/);
});

test('CLI effective union includes a one-line posture summary on conflicted fixture', async () => {
  const repo = join(testDir, 'fixtures', 'conflicted');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'json'],
    { cwd: packageRoot }
  );
  const report = JSON.parse(stdout);

  const posture = report.effectiveUnion.find((line) => line.startsWith('Strictest:') || line.includes('Loosest:'));
  assert.ok(posture, 'expected a posture line in the effective union');
  assert.match(posture, /Strictest: Claude/);
  assert.match(posture, /Loosest: Codex/);
});

test('CLI emits Markdown with matrix and union summary', async () => {
  const repo = join(testDir, 'fixtures', 'conflicted');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'markdown'],
    { cwd: packageRoot }
  );

  assert.match(stdout, /# PolicyMesh agent policy review: HIGH/);
  assert.match(stdout, /## Effective capability union/);
  assert.match(stdout, /## Surface matrix/);
  assert.match(stdout, /\| Capability \| Root MCP \| Cursor MCP \| VS Code MCP \| Codeium MCP \| Windsurf MCP \| Claude \| Codex \|/);
  assert.match(stdout, /MCP: github/);
  assert.match(stdout, /bash wildcards allowed \(Claude\)/);
  assert.match(stdout, /Surfaces: Root MCP, Cursor MCP, VS Code MCP, Windsurf MCP/);
});

test('CLI Markdown matrix cells stay free of unescaped pipes for pipe-prone commands', async () => {
  // After the v0.3 cell-label change, a curl-piped-to-bash command renders
  // as the semantic "unpinned" label rather than the raw command, so there
  // are no pipes to escape in the cell. The invariant we still want is
  // that no matrix row contains a stray unescaped pipe.
  const repo = join(testDir, 'fixtures', 'markdown-pipes');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'markdown'],
    { cwd: packageRoot }
  );

  const matrixRow = stdout
    .split('\n')
    .find((line) => line.startsWith('| MCP: installer |'));

  assert.ok(matrixRow, 'expected an MCP: installer row');
  // The semantic label is "unpinned" (curl|bash triggers the unpinned
  // detector). The raw shell pipeline never leaks into the cell.
  assert.match(matrixRow, /\| unpinned \|/);
  assert.doesNotMatch(matrixRow, /https:\/\/x\.sh/);
});

test('CLI emits GitHub warning annotations', async () => {
  const repo = join(testDir, 'fixtures', 'conflicted');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'github'],
    { cwd: packageRoot }
  );

  assert.match(stdout, /^::warning file=/m);
  assert.match(stdout, /different launch commands/);
  assert.match(stdout, /title=PolicyMesh high finding/);
  assert.match(stdout, /Surfaces: Root MCP, Cursor MCP, VS Code MCP, Windsurf MCP/);

  const mismatchAnnotations = stdout
    .split('\n')
    .filter((line) => line.includes('different launch commands'));
  assert.deepEqual(
    mismatchAnnotations.map((line) => /^::warning file=([^,]+)/.exec(line)?.[1]).sort(),
    [
      'test/fixtures/conflicted/.codeium/windsurf/mcp_config.json',
      'test/fixtures/conflicted/.codex/config.toml',
      'test/fixtures/conflicted/.cursor/mcp.json',
      'test/fixtures/conflicted/.mcp.json',
      'test/fixtures/conflicted/.vscode/mcp.json'
    ]
  );
});

test('CLI emits GitHub annotations for configured surfaces missing MCP servers', async () => {
  const repo = join(testDir, 'fixtures', 'empty-mcp-surface');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'github'],
    { cwd: packageRoot }
  );

  const missingAnnotations = stdout
    .split('\n')
    .filter((line) => line.includes('missing from Cursor MCP'));

  assert.deepEqual(
    missingAnnotations.map((line) => /^::warning file=([^,]+)/.exec(line)?.[1]).sort(),
    [
      'test/fixtures/empty-mcp-surface/.cursor/mcp.json',
      'test/fixtures/empty-mcp-surface/.mcp.json'
    ]
  );
});
