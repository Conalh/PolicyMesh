import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const claudeModule = await import(
  pathToFileURL(join(testDir, '..', 'dist', 'parsers', 'claude.js')).href
);
const { isBroadAllow } = claudeModule;
const mcpModule = await import(
  pathToFileURL(join(testDir, '..', 'dist', 'parsers', 'mcp.js')).href
);
const { isUnpinnedCommand } = mcpModule;
const { matchSecret } = await import('agent-gov-core');
const exceptionsModule = await import(
  pathToFileURL(join(testDir, '..', 'dist', 'exceptions.js')).href
);
const { applyExceptions } = exceptionsModule;
const localScriptsModule = await import(
  pathToFileURL(join(testDir, '..', 'dist', 'mesh', 'local-scripts.js')).href
);
const { localScriptCandidate } = localScriptsModule;
const privilegedModule = await import(
  pathToFileURL(join(testDir, '..', 'dist', 'mesh', 'privileged.js')).href
);
const { privilegedToken } = privilegedModule;
const diffModule = await import(
  pathToFileURL(join(testDir, '..', 'dist', 'diff.js')).href
);
const { diffReports } = diffModule;
const contextModule = await import(
  pathToFileURL(join(testDir, '..', 'dist', 'mesh', 'context.js')).href
);
const { makeMeshContext } = contextModule;

function makeReport(findings) {
  return {
    rating: findings.length ? findings[0].severity : 'none',
    findingCount: findings.length,
    surfaceCount: 1,
    findings,
    effectiveUnion: ['1 MCP server configured'],
    matrix: []
  };
}

function makeFinding(overrides = {}) {
  return {
    kind: 'policy_mesh.mcp_enabled_mismatch',
    severity: 'medium',
    file: '.mcp.json',
    subject: 'github',
    message: 'MCP server "github" enabled drift.',
    recommendation: 'Align surfaces.',
    surfaces: ['root_mcp', 'cursor_mcp'],
    ...overrides
  };
}

test('isBroadAllow: bare WebFetch is broad; scoped WebFetch is not', () => {
  assert.equal(isBroadAllow('WebFetch'), true);
  assert.equal(isBroadAllow('WebSearch'), true);
  assert.equal(isBroadAllow('WebFetch(domain:example.com)'), false);
  assert.equal(isBroadAllow('WebSearch(query:weather)'), false);
});

test('isBroadAllow: wildcard inside scope is still broad', () => {
  assert.equal(isBroadAllow('WebFetch(domain:*)'), true);
  assert.equal(isBroadAllow('Bash(rm -rf *)'), true);
});

test('isBroadAllow: specific MCP tool grants are narrow', () => {
  assert.equal(isBroadAllow('mcp__github__get_issue'), false);
  assert.equal(isBroadAllow('mcp__linear__create_ticket'), false);
});

test('isBroadAllow: bare server or wildcard MCP grants are broad', () => {
  assert.equal(isBroadAllow('mcp__github'), true);
  assert.equal(isBroadAllow('mcp__github__*'), true);
  assert.equal(isBroadAllow('mcp__*'), true);
});

test('isBroadAllow: filesystem grants on broad roots remain broad', () => {
  assert.equal(isBroadAllow('Read(~/**)'), true);
  assert.equal(isBroadAllow('Read(/)'), true);
  assert.equal(isBroadAllow('Write(C:\\)'), true);
  assert.equal(isBroadAllow('Read(src/specific-file.ts)'), false);
});

test('isBroadAllow: bare Task spawn is broad; scoped Task is not', () => {
  assert.equal(isBroadAllow('Task'), true);
  assert.equal(isBroadAllow('Task(explore-codebase)'), false);
});

test('isUnpinnedCommand: a GitHub URL pinned to a commit SHA is pinned; a branch URL is not', () => {
  const sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
  // Reproducible: the 40-char commit SHA makes the install immutable.
  assert.equal(
    isUnpinnedCommand({ command: 'npx', args: ['-y', `https://github.com/owner/repo/archive/${sha}.tar.gz`] }),
    false
  );
  // Mutable: a branch reference can move under you.
  assert.equal(
    isUnpinnedCommand({ command: 'npx', args: ['-y', 'https://github.com/owner/repo/archive/main.tar.gz'] }),
    true
  );
  // @latest stays unpinned regardless of host.
  assert.equal(isUnpinnedCommand({ command: 'npx', args: ['-y', 'some-pkg@latest'] }), true);
});

test('matchSecret: detects common provider prefixes', () => {
  assert.equal(matchSecret('sk-proj-fakeFAKEfakeFAKEfakeFAKE0123456789ABCDEF')?.provider, 'OpenAI');
  assert.equal(matchSecret('sk-ant-fakeFAKEfakeFAKEfakeFAKE0123456789')?.provider, 'Anthropic');
  assert.equal(matchSecret('ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')?.provider, 'GitHub');
  assert.equal(matchSecret('github_pat_AAAAAAAAAAAAAAAAAAAAAA')?.provider, 'GitHub');
  assert.equal(matchSecret('AKIAIOSFODNN7EXAMPLE')?.provider, 'AWS');
  assert.equal(matchSecret('AIzaSyA-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')?.provider, 'Google');
  assert.equal(matchSecret('xoxb-1234567890-fake-fake-fake-fake-fake-fake')?.provider, 'Slack');
  assert.equal(matchSecret('glpat-AAAAAAAAAAAAAAAAAAAA')?.provider, 'GitLab');
  assert.equal(matchSecret('npm_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA')?.provider, 'npm');
  assert.equal(matchSecret('dckr_pat_AAAAAAAAAAAAAAAAAAAA')?.provider, 'Docker');
  assert.equal(matchSecret('sk_live_AAAAAAAAAAAAAAAAAAAA')?.provider, 'Stripe');
});

test('matchSecret: env:VAR references are never flagged', () => {
  assert.equal(matchSecret('env:OPENAI_API_KEY'), undefined);
  assert.equal(matchSecret('env:ghp_REAL_LOOKING_TOKEN_NAME'), undefined);
});

test('matchSecret: short or benign values are not flagged', () => {
  assert.equal(matchSecret(''), undefined);
  assert.equal(matchSecret('root-token-value'), undefined);
  assert.equal(matchSecret('production'), undefined);
  assert.equal(matchSecret('sk-short'), undefined);
});

test('matchSecret: hex tokens are only flagged in env/header context', () => {
  const hex = 'a'.repeat(40);
  assert.equal(matchSecret(hex), undefined);
  assert.equal(matchSecret(hex, { envOrHeaderContext: true })?.provider, 'Hex token');
  // Commit SHAs (40 hex) appearing in a launch command must NOT trip the detector.
  assert.equal(matchSecret(`git checkout ${hex}`), undefined);
});

test('matchSecret: result never includes the literal secret', () => {
  const value = 'sk-proj-fakeFAKEfakeFAKEfakeFAKE0123456789ABCDEF';
  const result = matchSecret(value);
  assert.ok(result);
  assert.equal(JSON.stringify(result).includes(value), false);
});

test('applyExceptions: empty exception list is identity', () => {
  const findings = [makeFinding()];
  assert.deepEqual(applyExceptions(findings, []), findings);
});

test('applyExceptions: active exception suppresses matching finding', () => {
  const findings = [makeFinding()];
  const exceptions = [{
    kind: 'policy_mesh.mcp_enabled_mismatch',
    subject: 'github',
    expiry: '2999-12-31'
  }];
  assert.deepEqual(applyExceptions(findings, exceptions), []);
});

test('applyExceptions: missing expiry treated as perpetually active', () => {
  const findings = [makeFinding()];
  const exceptions = [{ kind: 'policy_mesh.mcp_enabled_mismatch', subject: 'github' }];
  assert.deepEqual(applyExceptions(findings, exceptions), []);
});

test('applyExceptions: expired exception surfaces finding with downgrade and prefix', () => {
  const findings = [makeFinding({ severity: 'high' })];
  const exceptions = [{
    kind: 'policy_mesh.mcp_enabled_mismatch',
    subject: 'github',
    expiry: '2020-01-01'
  }];
  const result = applyExceptions(findings, exceptions);
  assert.equal(result.length, 1);
  assert.equal(result[0].severity, 'low');
  assert.match(result[0].message, /^\[EXPIRED WHITELIST\]/);
});

test('applyExceptions: exception with matching signature still suppresses', () => {
  const finding = makeFinding();
  const { computeFindingSignature } = exceptionsModule;
  const exceptions = [{
    kind: finding.kind,
    subject: finding.subject,
    signature: computeFindingSignature(finding)
  }];
  assert.deepEqual(applyExceptions([finding], exceptions), []);
});

test('applyExceptions: signature mismatch surfaces finding with explanatory prefix', () => {
  const finding = makeFinding();
  const exceptions = [{
    kind: finding.kind,
    subject: finding.subject,
    signature: 'deadbeefdeadbeef' // never matches
  }];
  const result = applyExceptions([finding], exceptions);
  assert.equal(result.length, 1);
  assert.match(result[0].message, /^\[SIGNATURE MISMATCH\]/);
  assert.match(result[0].message, /re-review and update the baseline/);
});

test('applyExceptions: signature takes precedence over expiry', () => {
  const finding = makeFinding();
  const exceptions = [{
    kind: finding.kind,
    subject: finding.subject,
    signature: 'deadbeefdeadbeef',
    expiry: '2999-12-31'
  }];
  const result = applyExceptions([finding], exceptions);
  // Signature mismatch fires the finding regardless of an otherwise-active expiry.
  assert.equal(result.length, 1);
  assert.match(result[0].message, /^\[SIGNATURE MISMATCH\]/);
});

test('applyExceptions: non-matching kind or subject passes through unchanged', () => {
  const findings = [makeFinding()];
  const wrongKind = [{ kind: 'policy_mesh.mcp_command_mismatch', subject: 'github' }];
  const wrongSubject = [{ kind: 'policy_mesh.mcp_enabled_mismatch', subject: 'analytics' }];
  assert.deepEqual(applyExceptions(findings, wrongKind), findings);
  assert.deepEqual(applyExceptions(findings, wrongSubject), findings);
});

test('localScriptCandidate: relative script in args is detected', () => {
  assert.equal(
    localScriptCandidate({ command: 'node ./scripts/run.js', args: ['./scripts/run.js'] }),
    './scripts/run.js'
  );
  assert.equal(
    localScriptCandidate({ command: 'python ./tools/db.py', args: ['./tools/db.py'] }),
    './tools/db.py'
  );
});

test('localScriptCandidate: relative script as command itself is detected', () => {
  assert.equal(
    localScriptCandidate({ command: './bin/runner.sh', args: [] }),
    './bin/runner.sh'
  );
});

test('localScriptCandidate: package names and bare commands are ignored', () => {
  assert.equal(
    localScriptCandidate({ command: 'npx -y @modelcontextprotocol/server-github@1.2.3', args: ['-y', '@modelcontextprotocol/server-github@1.2.3'] }),
    undefined
  );
  assert.equal(
    localScriptCandidate({ command: 'node', args: [] }),
    undefined
  );
});

test('localScriptCandidate: absolute paths and URLs are ignored', () => {
  assert.equal(
    localScriptCandidate({ command: '/usr/local/bin/script.sh', args: [] }),
    undefined
  );
  assert.equal(
    localScriptCandidate({ command: 'C:\\Users\\me\\script.bat', args: [] }),
    undefined
  );
  assert.equal(
    localScriptCandidate({ command: 'curl https://example.com/foo.js', args: ['https://example.com/foo.js'] }),
    undefined
  );
});

test('privilegedToken: detects elevation utilities as command first token', () => {
  assert.equal(privilegedToken({ command: 'sudo node ./x.js', args: ['node', './x.js'] }), 'sudo');
  assert.equal(privilegedToken({ command: 'doas node ./x.js', args: ['node', './x.js'] }), 'doas');
  assert.equal(privilegedToken({ command: 'pkexec /opt/agent', args: ['/opt/agent'] }), 'pkexec');
  assert.equal(privilegedToken({ command: 'runas /user:admin cmd', args: ['/user:admin', 'cmd'] }), 'runas');
});

test('privilegedToken: detects elevation via absolute path or extension', () => {
  assert.equal(privilegedToken({ command: '/usr/bin/sudo node ./x.js', args: ['node', './x.js'] }), 'sudo');
  assert.equal(privilegedToken({ command: 'C:\\Tools\\gsudo.exe node x.js', args: ['node', 'x.js'] }), 'gsudo');
});

test('privilegedToken: detects elevation in args[0] for wrapper invocations', () => {
  assert.equal(privilegedToken({ command: 'env', args: ['sudo', 'node', './x.js'] }), 'sudo');
});

test('privilegedToken: normal commands are not flagged', () => {
  assert.equal(privilegedToken({ command: 'node ./x.js', args: ['./x.js'] }), undefined);
  assert.equal(privilegedToken({ command: 'npx -y @org/pkg', args: ['-y', '@org/pkg'] }), undefined);
  // Substring matches must not trip the detector.
  assert.equal(privilegedToken({ command: 'pseudo-tool', args: [] }), undefined);
});

test('diffReports: identical reports produce an empty delta', () => {
  const finding = makeFinding();
  const base = makeReport([finding]);
  const head = makeReport([finding]);

  const delta = diffReports(base, head);
  assert.equal(delta.findingCount, 0);
  assert.equal(delta.rating, 'none');
  // Matrix and effectiveUnion still come from head so the reviewer sees the full picture.
  assert.deepEqual(delta.effectiveUnion, head.effectiveUnion);
});

test('diffReports: finding only in head is included as new', () => {
  const base = makeReport([]);
  const head = makeReport([makeFinding({ subject: 'github' })]);

  const delta = diffReports(base, head);
  assert.equal(delta.findingCount, 1);
  assert.equal(delta.findings[0].subject, 'github');
  // Message is not prefixed — it is new, not worsened.
  assert.doesNotMatch(delta.findings[0].message, /WORSENED/);
});

test('diffReports: finding worsened in head is included with WORSENED prefix and new severity', () => {
  const base = makeReport([makeFinding({ severity: 'low' })]);
  const head = makeReport([makeFinding({ severity: 'high' })]);

  const delta = diffReports(base, head);
  assert.equal(delta.findingCount, 1);
  assert.equal(delta.findings[0].severity, 'high');
  assert.match(delta.findings[0].message, /^\[WORSENED from low\]/);
});

test('diffReports: finding present in base but resolved in head is dropped', () => {
  const base = makeReport([makeFinding({ subject: 'github' })]);
  const head = makeReport([]);

  const delta = diffReports(base, head);
  assert.equal(delta.findingCount, 0);
});

test('diffReports: surfaces resolvedFindings when base findings disappear in head', () => {
  const fixedFinding = makeFinding({ subject: 'github', severity: 'high', message: 'mismatch' });
  const base = makeReport([fixedFinding]);
  const head = makeReport([]);

  const delta = diffReports(base, head);
  assert.equal(delta.findingCount, 0);
  assert.ok(delta.resolvedFindings);
  assert.equal(delta.resolvedFindings.length, 1);
  assert.equal(delta.resolvedFindings[0].subject, 'github');
});

test('diffReports: omits resolvedFindings field when nothing was resolved', () => {
  const finding = makeFinding();
  const base = makeReport([finding]);
  const head = makeReport([finding]);

  const delta = diffReports(base, head);
  assert.equal(delta.resolvedFindings, undefined);
});

test('makeMeshContext: indexes servers by name across surfaces in a single pass', () => {
  const policies = {
    mcpSurfaces: [
      {
        surfaceId: 'root_mcp',
        file: '.mcp.json',
        servers: [
          { name: 'github', command: 'npx', enabled: true, env: {}, headers: {}, file: '.mcp.json', surfaceId: 'root_mcp', canonicalIdentity: 'npx', unpinned: false },
          { name: 'linear', command: 'npx', enabled: true, env: {}, headers: {}, file: '.mcp.json', surfaceId: 'root_mcp', canonicalIdentity: 'npx', unpinned: false }
        ]
      },
      {
        surfaceId: 'cursor_mcp',
        file: '.cursor/mcp.json',
        servers: [
          { name: 'github', command: 'npx', enabled: false, env: {}, headers: {}, file: '.cursor/mcp.json', surfaceId: 'cursor_mcp', canonicalIdentity: 'npx', unpinned: false }
        ]
      }
    ]
  };

  const ctx = makeMeshContext(policies);
  // Same name across surfaces gets one map entry with both servers.
  assert.equal(ctx.serversByName.get('github').length, 2);
  // Names unique to one surface still appear.
  assert.equal(ctx.serversByName.get('linear').length, 1);
  // mcpSurfaceIds preserves order from the policies.
  assert.deepEqual(ctx.mcpSurfaceIds, ['root_mcp', 'cursor_mcp']);
  // allMcpServers is a flat list of every (surface, server) pair.
  assert.equal(ctx.allMcpServers.length, 3);
});

test('makeMeshContext: empty policies produces empty indexes', () => {
  const ctx = makeMeshContext({ mcpSurfaces: [] });
  assert.equal(ctx.serversByName.size, 0);
  assert.equal(ctx.allMcpServers.length, 0);
  assert.deepEqual(ctx.mcpSurfaceIds, []);
});

test('diffReports: rating reflects only delta findings, not base or head', () => {
  // head has a pre-existing low and a new critical; delta should be critical.
  const base = makeReport([makeFinding({ subject: 'github', severity: 'low' })]);
  const head = makeReport([
    makeFinding({ subject: 'github', severity: 'low' }),
    makeFinding({ subject: 'analytics', severity: 'critical' })
  ]);

  const delta = diffReports(base, head);
  assert.equal(delta.rating, 'critical');
  assert.equal(delta.findingCount, 1);
  assert.equal(delta.findings[0].subject, 'analytics');
});
