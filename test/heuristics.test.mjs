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
