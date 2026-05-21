import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testDir, '..');

test('release metadata is prepared for v0.1.2 Action users', async () => {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(await readFile(join(packageRoot, 'package-lock.json'), 'utf8'));
  const readme = await readFile(join(packageRoot, 'README.md'), 'utf8');

  assert.equal(packageJson.version, '0.1.2');
  assert.equal(packageLock.version, '0.1.2');
  assert.equal(packageLock.packages[''].version, '0.1.2');
  assert.match(readme, /uses: Conalh\/PolicyMesh@v0\.1\.2/);
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
  assert.match(teamValidation, /Team workflow/);
  assert.match(teamValidation, /Paid-layer signal/);
  assert.match(readme, /team-validation\.yml/);
  assert.match(readme, /issues\/5/);
});

test('README documents Action credibility and robustness signals', async () => {
  const readme = await readFile(join(packageRoot, 'README.md'), 'utf8');

  assert.match(readme, /VS Code and Codeium\/Windsurf MCP configs/);
  assert.match(readme, /Malformed JSON agent config files/);
  assert.match(readme, /team validation signal/);
});
