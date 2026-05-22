import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const execFileAsync = promisify(execFile);
const testDir = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(testDir, '..');

test('release metadata is prepared for v0.1.18 Action users', async () => {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(await readFile(join(packageRoot, 'package-lock.json'), 'utf8'));
  const readme = await readFile(join(packageRoot, 'README.md'), 'utf8');

  assert.equal(packageJson.version, '0.1.18');
  assert.equal(packageLock.version, '0.1.18');
  assert.equal(packageLock.packages[''].version, '0.1.18');
  assert.match(readme, /uses: Conalh\/PolicyMesh@v0\.1\.18/);
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
    'codeium',
    'windsurf'
  ]);
});

test('action.yml declares audit inputs and outputs', async () => {
  const action = await readFile(join(packageRoot, 'action.yml'), 'utf8');

  assert.match(action, /name: PolicyMesh/);
  assert.match(action, /fail-on:/);
  assert.match(action, /surface-count:/);
  assert.match(action, /cd "\$\{GITHUB_WORKSPACE:-\.\}"/);
  assert.match(action, /audit --repo/);
});

test('published Action runs the bundled CLI without installing or rebuilding itself', async () => {
  const action = await readFile(join(packageRoot, 'action.yml'), 'utf8');
  const gitignore = await readFile(join(packageRoot, '.gitignore'), 'utf8');
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', 'dist/index.js', 'dist/audit.js'],
    { cwd: packageRoot }
  );
  const trackedDistFiles = stdout.trim().split(/\r?\n/).filter(Boolean);

  assert.match(action, /node "\$GITHUB_ACTION_PATH\/dist\/index\.js" audit --repo/);
  assert.doesNotMatch(action, /npm ci/);
  assert.doesNotMatch(action, /npm run build/);
  assert.doesNotMatch(gitignore, /^dist\/\s*$/m);
  assert.ok(trackedDistFiles.includes('dist/index.js'));
  assert.ok(trackedDistFiles.includes('dist/audit.js'));
});

test('CI workflow builds and tests PolicyMesh', async () => {
  const workflow = await readFile(join(packageRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run build/);
  assert.match(workflow, /git diff --exit-code -- dist/);
  assert.match(workflow, /npm test/);
});

test('PolicyMesh workflow self-dogfoods the action', async () => {
  const workflow = await readFile(join(packageRoot, '.github', 'workflows', 'policymesh.yml'), 'utf8');

  assert.match(workflow, /npm ci/);
  assert.match(workflow, /npm run build/);
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

  assert.match(readme, /VS Code and Windsurf MCP configs/);
  assert.match(readme, /`\.codeium\/mcp_config\.json`/);
  assert.match(readme, /`\.codeium\/windsurf\/mcp_config\.json`/);
  assert.match(readme, /configured MCP surfaces with empty server maps/);
  assert.match(readme, /MCP server enabled\/disabled drift across surfaces/);
  assert.match(readme, /MCP server environment drift across surfaces/);
  assert.match(readme, /MCP remote header drift across surfaces/);
  assert.match(readme, /Codex MCP servers from `\.codex\/config\.toml`/);
  assert.match(readme, /annotations on configured surfaces that are missing MCP servers/);
  assert.match(readme, /subdirectory audits/);
  assert.match(readme, /Codex network access enabled alongside other configured or unreadable agent surfaces/);
  assert.match(readme, /Claude MCP grants for servers missing from MCP configs/);
  assert.match(readme, /Malformed JSON and Codex TOML agent config files/);
  assert.match(readme, /team validation signal/);
});

test('README separates original demo PR proof from richer fixture proof', async () => {
  const readme = await readFile(join(packageRoot, 'README.md'), 'utf8');
  const demoSection = readme.slice(readme.indexOf('## Demo'), readme.indexOf('## Local Use'));
  const originalProof = demoSection.slice(0, demoSection.indexOf('The local fixture extends that proof with:'));

  assert.match(demoSection, /Original demo PR:/);
  assert.match(demoSection, /The original PR intentionally adds:/);
  assert.match(demoSection, /The local fixture extends that proof with:/);
  assert.doesNotMatch(originalProof, /Codex MCP table/);
  assert.doesNotMatch(originalProof, /VS Code and Codeium\/Windsurf/);
});
