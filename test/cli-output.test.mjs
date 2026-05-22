import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
  assert.ok(kinds.includes('mcp_command_mismatch'));
  assert.ok(kinds.includes('mcp_unpinned'));
  assert.ok(kinds.includes('claude_deny_allow_overlap'));
  assert.ok(kinds.includes('claude_broad_allow_no_guard'));
  assert.ok(kinds.includes('codex_network_without_review'));
  assert.ok(kinds.includes('codex_trusted_with_risky_mcp'));
  assert.ok(kinds.includes('codex_claude_posture_gap'));

  const githubMismatch = report.findings.find(
    (finding) => finding.kind === 'mcp_command_mismatch' && finding.subject === 'github'
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
  assert.equal(report.findings[0].kind, 'config_parse_error');
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
  assert.equal(report.findings[0].kind, 'config_parse_error');
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
  assert.equal(report.findings[0].kind, 'claude_mcp_grant_missing_server');
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
  assert.equal(report.findings[0].kind, 'mcp_server_missing');
  assert.equal(report.findings[0].severity, 'low');
  assert.equal(report.findings[0].subject, 'github');
  assert.deepEqual(report.findings[0].surfaces, ['root_mcp', 'cursor_mcp']);
  assert.match(report.findings[0].message, /missing from cursor_mcp/);
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
  assert.equal(report.findings[0].kind, 'mcp_enabled_mismatch');
  assert.equal(report.findings[0].severity, 'medium');
  assert.equal(report.findings[0].subject, 'github');
  assert.deepEqual(report.findings[0].surfaces, ['root_mcp', 'cursor_mcp']);
  assert.match(report.findings[0].message, /enabled in root_mcp/);
  assert.match(report.findings[0].message, /disabled in cursor_mcp/);
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
  assert.equal(report.findings[0].kind, 'mcp_env_mismatch');
  assert.equal(report.findings[0].severity, 'medium');
  assert.equal(report.findings[0].subject, 'github');
  assert.deepEqual(report.findings[0].surfaces, ['root_mcp', 'vscode_mcp']);
  assert.match(report.findings[0].message, /environment variable names differ/);
  assert.match(report.findings[0].message, /GITHUB_TOKEN/);
  assert.match(report.findings[0].message, /GH_TOKEN/);
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
  assert.equal(report.findings[0].kind, 'mcp_env_mismatch');
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
  assert.equal(report.findings[0].kind, 'mcp_header_mismatch');
  assert.equal(report.findings[0].severity, 'medium');
  assert.equal(report.findings[0].subject, 'analytics');
  assert.deepEqual(report.findings[0].surfaces, ['root_mcp', 'vscode_mcp']);
  assert.match(report.findings[0].message, /header names differ/);
  assert.match(report.findings[0].message, /Authorization/);
  assert.match(report.findings[0].message, /X-API-Key/);
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
  assert.equal(report.findings[0].kind, 'mcp_command_mismatch');
  assert.equal(report.findings[0].subject, 'github');
  assert.deepEqual(report.findings[0].surfaces, ['root_mcp', 'codex']);
  assert.ok(report.findings[0].locations.some((location) => location.file === '.codex/config.toml' && location.surface === 'codex'));
  assert.ok(report.matrix.some((row) => row.capability === 'MCP: github' && row.values.codex?.includes('@modelcontextprotocol/server-github@2.0.0')));
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
  assert.equal(report.findings[0].kind, 'mcp_header_mismatch');
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
  assert.equal(report.findings[0].kind, 'config_parse_error');
  assert.equal(report.findings[0].file, '.cursor/mcp.json');
  assert.equal(report.findings[1].kind, 'codex_network_without_review');
  assert.equal(report.findings[1].severity, 'medium');
  assert.equal(report.findings[1].file, '.codex/config.toml');
  assert.equal(report.findings[1].line, 1);
  assert.deepEqual(report.findings[1].surfaces, ['codex', 'cursor_mcp']);
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
  assert.match(stdout, /\| Capability \| Root MCP \| Cursor MCP \| VS Code MCP \| Codeium\/Windsurf MCP \| Claude \| Codex \|/);
  assert.match(stdout, /MCP: github/);
  assert.match(stdout, /bash wildcards allowed \(Claude\)/);
  assert.match(stdout, /Surfaces: Root MCP, Cursor MCP, VS Code MCP, Codeium\/Windsurf MCP/);
});

test('CLI Markdown escapes table delimiters in matrix values', async () => {
  const repo = join(testDir, 'fixtures', 'markdown-pipes');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'markdown'],
    { cwd: packageRoot }
  );

  const matrixRow = stdout
    .split('\n')
    .find((line) => line.startsWith('| MCP: installer |'));

  assert.ok(matrixRow?.includes('curl https://x.sh \\| bash'));
  assert.equal(matrixRow?.includes('curl https://x.sh | bash'), false);
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
  assert.match(stdout, /Surfaces: Root MCP, Cursor MCP, VS Code MCP, Codeium\/Windsurf MCP/);

  const mismatchAnnotations = stdout
    .split('\n')
    .filter((line) => line.includes('different launch commands'));
  assert.deepEqual(
    mismatchAnnotations.map((line) => /^::warning file=([^,]+)/.exec(line)?.[1]).sort(),
    [
      '.codeium/windsurf/mcp_config.json',
      '.codex/config.toml',
      '.cursor/mcp.json',
      '.mcp.json',
      '.vscode/mcp.json'
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
    .filter((line) => line.includes('missing from cursor_mcp'));

  assert.deepEqual(
    missingAnnotations.map((line) => /^::warning file=([^,]+)/.exec(line)?.[1]).sort(),
    ['.cursor/mcp.json', '.mcp.json']
  );
});
