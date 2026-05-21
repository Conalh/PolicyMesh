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
  assert.ok(report.surfaceCount >= 3);
  assert.ok(report.effectiveUnion.length > 0);
  assert.ok(report.matrix.length > 0);
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
  assert.match(stdout, /MCP: github/);
  assert.match(stdout, /bash wildcards allowed \(Claude\)/);
});

test('CLI emits GitHub warning annotations', async () => {
  const repo = join(testDir, 'fixtures', 'conflicted');

  const { stdout } = await execFileAsync(
    process.execPath,
    ['dist/index.js', 'audit', '--repo', repo, '--format', 'github'],
    { cwd: packageRoot }
  );

  assert.match(stdout, /^::warning file=/m);
  assert.match(stdout, /mcp_command_mismatch|different launch commands|PolicyMesh high policy conflict/);
});
