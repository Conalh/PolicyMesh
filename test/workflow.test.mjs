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

test('release metadata is prepared for v0.4.0 Action users', async () => {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(await readFile(join(packageRoot, 'package-lock.json'), 'utf8'));
  const readme = await readFile(join(packageRoot, 'README.md'), 'utf8');

  assert.equal(packageJson.version, '0.4.0');
  assert.equal(packageLock.version, '0.4.0');
  assert.equal(packageLock.packages[''].version, '0.4.0');
  assert.match(readme, /uses: Conalh\/PolicyMesh@v0\.4\.0/);
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

test('package.json is publishable to npm with the right allowlist', async () => {
  const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8'));

  // CLI binary registration so `npx policymesh@latest audit` works without install.
  assert.deepEqual(packageJson.bin, { policymesh: './dist/index.js' });

  // Public-by-default; first publish under @scope would otherwise fail.
  assert.deepEqual(packageJson.publishConfig, { access: 'public' });

  // Only the runtime artefacts ship. No src/, no test/, no fixtures.
  assert.deepEqual(packageJson.files, ['dist/', 'action.yml', 'README.md', 'LICENSE']);

  // prepublishOnly builds and tests before any version reaches the registry.
  assert.equal(packageJson.scripts.prepublishOnly, 'npm run build && npm test');
});

test('dist/index.js preserves the executable shebang so npm-installed bin works', async () => {
  const first = (await readFile(join(packageRoot, 'dist', 'index.js'), 'utf8')).split('\n', 1)[0];
  assert.equal(first, '#!/usr/bin/env node');
});

test('docs/workflows/agent-governance.yml composes the suite for adopters', async () => {
  const template = await readFile(join(packageRoot, 'docs', 'workflows', 'agent-governance.yml'), 'utf8');

  assert.match(template, /uses: Conalh\/ScopeTrail/);
  assert.match(template, /uses: Conalh\/PolicyMesh/);
  assert.match(template, /uses: Conalh\/CapabilityEcho/);
  // PolicyMesh in the template uses the recommended diff-mode defaults.
  assert.match(template, /diff: true/);
  assert.match(template, /fetch-depth: 0/);
});

test('action.yml declares audit inputs and outputs', async () => {
  const action = await readFile(join(packageRoot, 'action.yml'), 'utf8');

  assert.match(action, /name: PolicyMesh/);
  assert.match(action, /fail-on:/);
  assert.match(action, /surface-count:/);
  assert.match(action, /cd "\$\{GITHUB_WORKSPACE:-\.\}"/);
  assert.match(action, /audit --repo/);
});

test('action.yml supports optional sticky PR summary comment via github-token input', async () => {
  const action = await readFile(join(packageRoot, 'action.yml'), 'utf8');

  // Input is declared and explicitly optional.
  assert.match(action, /github-token:/);
  assert.match(action, /required: false/);
  // Sticky marker prevents duplicate comments per push.
  assert.match(action, /policymesh:pr-summary/);
  // Gated on pull_request event so non-PR runs are no-ops.
  assert.match(action, /GITHUB_EVENT_NAME.*pull_request/);
  // Uses gh api so we never embed a token in URLs.
  assert.match(action, /GH_TOKEN="\$MESH_GITHUB_TOKEN" gh api/);
});

test('action.yml exposes the --recursive flag as the "recursive" input', async () => {
  const action = await readFile(join(packageRoot, 'action.yml'), 'utf8');

  assert.match(action, /recursive:\s*\n\s*description:/);
  assert.match(action, /MESH_RECURSIVE:\s*\$\{\{\s*inputs\.recursive\s*\}\}/);
  // Gating logic appends --recursive to the audit args only when the input is true.
  assert.match(action, /MESH_RECURSIVE.*=.*"true"/);
});

test('action.yml exposes diff mode that audits the PR base and gates fail-on the delta', async () => {
  const action = await readFile(join(packageRoot, 'action.yml'), 'utf8');

  // Input + env passthrough.
  assert.match(action, /^\s{2}diff:/m);
  assert.match(action, /MESH_DIFF:\s*\$\{\{\s*inputs\.diff\s*\}\}/);
  // Gated on pull_request event so non-PR runs never invoke git worktree.
  assert.match(action, /MESH_DIFF.*=.*"true".*GITHUB_EVENT_NAME.*=.*pull_request/s);
  // Worktree is used for the base audit and torn down after.
  assert.match(action, /git worktree add --detach "\$base_dir"/);
  assert.match(action, /git worktree remove --force "\$base_dir"/);
  // Annotations and outputs use the delta when diff is on.
  assert.match(action, /annotations_source="\$delta_json"/);
  assert.match(action, /rating_source="\$delta_json"/);
  // The full head report is still rendered for the markdown step summary.
  assert.match(action, /render --input "\$json_file" --format markdown/);
});

test('action.yml runs a single audit pass and renders the other formats from saved JSON', async () => {
  const action = await readFile(join(packageRoot, 'action.yml'), 'utf8');

  // Exactly one audit invocation; render handles the other formats.
  const auditInvocations = action.match(/index\.js" .* audit /g) ?? [];
  assert.equal(auditInvocations.length, 0, 'audit args are now built into an array; no inline audit invocations expected');
  assert.match(action, /index\.js" "\$\{audit_args\[@\]\}" > "\$json_file"/);
  assert.match(action, /index\.js" render --input "\$json_file" --format markdown/);
  // Annotations source is dynamic — head by default, delta in diff mode.
  assert.match(action, /index\.js" render --input "\$annotations_source" --format github/);
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

  // Audit args are built into a bash array; literal "audit --repo" still
  // appears in that initializer, just not directly after the node call.
  assert.match(action, /audit_args=\(audit --repo "\$repo"/);
  assert.match(action, /node "\$GITHUB_ACTION_PATH\/dist\/index\.js" "\$\{audit_args\[@\]\}"/);
  assert.match(action, /npm ci .*--omit=dev/);
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
  const teamPilot = await readFile(join(packageRoot, 'docs', 'TEAM_PILOT.md'), 'utf8');

  assert.match(falsePositive, /repository-count/);
  assert.match(missingSurface, /Review surface/);
  assert.match(teamValidation, /Approximate repository count/);
  assert.match(teamValidation, /Active agent surfaces/);
  assert.match(teamValidation, /Central enforcement need/);
  assert.match(teamValidation, /Shared baselines or defaults/);
  assert.match(teamValidation, /Exception workflow need/);
  assert.match(teamValidation, /Reporting or export need/);
  assert.match(teamValidation, /Team workflow/);
  assert.match(teamValidation, /Team workflow gap/);
  assert.match(teamPilot, /Conalh\/PolicyMesh@v0\.4\.0/);
  assert.match(teamPilot, /Run across at least two repositories/);
  assert.match(teamPilot, /Finding counts by severity/);
  assert.match(teamPilot, /shared baselines/);
  assert.match(teamPilot, /exception ownership/);
  assert.match(teamPilot, /cross-repo reports/);
  assert.match(teamPilot, /team-validation\.yml/);
  assert.match(readme, /TEAM_PILOT\.md/);
  assert.match(readme, /team-validation\.yml/);
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
  assert.match(readme, /team feedback form/);
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
