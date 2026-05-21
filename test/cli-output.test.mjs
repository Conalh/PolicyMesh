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
      '.cursor/mcp.json',
      '.mcp.json',
      '.vscode/mcp.json'
    ]
  );
});
