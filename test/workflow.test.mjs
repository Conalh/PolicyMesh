import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testDir, '..');

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
