import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testDir, '..');

test('release metadata is prepared for v0.1.13 Action users', async () => {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(await readFile(join(packageRoot, 'package-lock.json'), 'utf8'));
  const readme = await readFile(join(packageRoot, 'README.md'), 'utf8');

  assert.equal(packageJson.version, '0.1.13');
  assert.equal(packageLock.version, '0.1.13');
  assert.equal(packageLock.packages[''].version, '0.1.13');
  assert.match(readme, /uses: Conalh\/PolicyMesh@v0\.1\.13/);
});

test('package metadata supports OSS discovery', async () => {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));

  assert.deepEqual(packageJson.repository, {
    type: 'git',
    url: 'git+https://github.com/Conalh/PolicyMesh.git'
  });
  assert.deepEqual(packageJson.bugs, {
    url: 'https://github.com/Conalh/PolicyMesh/issues'
  });
  assert.equal(packageJson.homepage, 'https://github.com/Conalh/PolicyMesh#readme');
  assert.deepEqual(packageJson.keywords, [
    'ai-agents',
    'github-action',
    'policy-as-code',
    'mcp',
    'claude',
    'cursor',
    'codex',
    'vscode',
    'codeium'
  ]);
});

test('action.yml declares audit inputs and outputs', async () => {
  const action = await readFile(join(packageRoot, 'action.yml'), 'utf8');

  assert.match(action, /name: PolicyMesh/);
  assert.match(action, /fail-on:/);
  assert.match(action, /surface-count:/);
  assert.match(action, /audit --repo/);
});

test('CI workflow builds and tests PolicyMesh', async () => {
  const workflow = await readFile(join(packageRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /npm test/);
});

test('PolicyMesh workflow self-dogfoods the action', async () => {
  const workflow = await readFile(join(packageRoot, '.github', 'workflows', 'policymesh.yml'), 'utf8');

  assert.match(workflow, /uses: \.\//);
  assert.match(workflow, /fail-on: none/);
});

test('issue templates collect detector and team validation feedback', async () => {
  const falsePositive = await readFile(join(packageRoot, '.github', 'ISSUE_TEMPLATE', 'false-positive.yml'), 'utf8');
  const missingSurface = await readFile(join(packageRoot, '.github', 'ISSUE_TEMPLATE', 'missing-surface.yml'), 'utf8');
  const teamValidation = await readFile(join(packageRoot, '.github', 'ISSUE_TEMPLATE', 'team-validation.yml'), 'utf8');
  const readme = await readFile(join(packageRoot, 'README.md'), 'utf8');

  assert.match(falsePositive, /repository-count/);
  assert.match(missingSurface, /Review surface/);
  assert.match(teamValidation, /Approximate repository count/);
  assert.match(teamValidation, /Active agent surfaces/);
  assert.match(teamValidation, /Central enforcement need/);
  assert.match(teamValidation, /Shared baselines or defaults/);
  assert.match(teamValidation, /Exception workflow need/);
  assert.match(teamValidation, /Reporting or export need/);
  assert.match(teamValidation, /Team workflow/);
  assert.match(teamValidation, /Paid-layer signal/);
  assert.match(readme, /team-validation\.yml/);
  assert.match(readme, /issues\/5/);
});

test('README documents Action credibility and robustness signals', async () => {
  const readme = await readFile(join(packageRoot, 'README.md'), 'utf8');

  assert.match(readme, /VS Code and Codeium\/Windsurf MCP configs/);
  assert.match(readme, /configured MCP surfaces with empty server maps/);
  assert.match(readme, /MCP server enabled\/disabled drift across surfaces/);
  assert.match(readme, /MCP server environment drift across surfaces/);
  assert.match(readme, /MCP remote header drift across surfaces/);
  assert.match(readme, /Codex MCP servers from `\.codex\/config\.toml`/);
  assert.match(readme, /annotations on configured surfaces that are missing MCP servers/);
  assert.match(readme, /Codex network access enabled alongside other configured or unreadable agent surfaces/);
  assert.match(readme, /Claude MCP grants for servers missing from MCP configs/);
  assert.match(readme, /Malformed JSON and Codex TOML agent config files/);
  assert.match(readme, /team validation signal/);
});
