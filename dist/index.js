#!/usr/bin/env node
import { stat } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditRepo } from './audit.js';
import { auditRecursive } from './recursive.js';
import { renderReport } from './report.js';
export { auditRepo } from './audit.js';
export async function main(argv = process.argv.slice(2)) {
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
        process.stdout.write(`${usage()}\n`);
        return 0;
    }
    if (argv[0] === 'audit') {
        return runAudit(argv.slice(1));
    }
    process.stderr.write(`Unknown command: ${argv[0]}\n`);
    return 2;
}
async function runAudit(argv) {
    const parsed = parseAuditArgs(argv);
    if (!parsed.ok) {
        process.stderr.write(`${parsed.error}\n${usage()}\n`);
        return 2;
    }
    const repoError = await validateRepoPath(parsed.repo);
    if (repoError) {
        process.stderr.write(`${repoError}\n`);
        return 2;
    }
    const report = parsed.recursive
        ? await auditRecursive(parsed.repo)
        : await auditRepo(parsed.repo);
    process.stdout.write(renderReport(report, parsed.format, {
        githubAnnotationPathPrefix: githubAnnotationPathPrefix(parsed.repo)
    }));
    return 0;
}
function parseAuditArgs(argv) {
    let repo = process.cwd();
    let format = 'text';
    let recursive = false;
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];
        const value = argv[index + 1];
        if (arg === '--repo') {
            if (!value || value.startsWith('--')) {
                return { ok: false, error: 'Missing value for --repo' };
            }
            repo = value;
            index += 1;
        }
        else if (arg === '--format') {
            if (!isReportFormat(value)) {
                return { ok: false, error: `Invalid format: ${value ?? ''}` };
            }
            format = value;
            index += 1;
        }
        else if (arg === '--recursive' || arg === '-r') {
            recursive = true;
        }
        else {
            return { ok: false, error: `Unknown argument: ${arg}` };
        }
    }
    return { ok: true, repo, format, recursive };
}
function isReportFormat(value) {
    return value === 'text' || value === 'markdown' || value === 'json' || value === 'github';
}
function githubAnnotationPathPrefix(repo) {
    const prefix = relative(process.cwd(), resolve(repo));
    return prefix && prefix !== '.' && !prefix.startsWith('..') ? prefix : undefined;
}
async function validateRepoPath(repo) {
    try {
        const stats = await stat(repo);
        return stats.isDirectory() ? undefined : `Repository path is not a directory: ${repo}`;
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
            return `Repository path does not exist: ${repo}`;
        }
        throw error;
    }
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
const invokedPath = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;
if (invokedPath) {
    process.exitCode = await main();
}
function usage() {
    return 'Usage: policymesh audit --repo <path> [--format text|markdown|json|github] [--recursive]';
}
