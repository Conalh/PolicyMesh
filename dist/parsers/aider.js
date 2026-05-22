import { readFile } from 'node:fs/promises';
import { configPath } from '../discovery.js';
const AIDER_CONFIG_FILE = '.aider.conf.yml';
export async function parseAiderPolicy(root) {
    let text = '';
    try {
        text = await readFile(configPath(root, AIDER_CONFIG_FILE), 'utf8');
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
            return { findings: [] };
        }
        throw error;
    }
    if (!text.trim()) {
        return { findings: [] };
    }
    const entries = parseTopLevelYaml(text);
    const model = entries.get('model')?.value;
    const autoCommits = readBoolean(entries.get('auto-commits')?.value);
    const dangerous = entries.get('dangerously-allow-non-git');
    const dangerouslyAllowNonGit = readBoolean(dangerous?.value);
    const autoAcceptArchitect = readBoolean(entries.get('auto-accept-architect')?.value);
    if (model === undefined
        && autoCommits === undefined
        && dangerouslyAllowNonGit === undefined
        && autoAcceptArchitect === undefined) {
        return { findings: [] };
    }
    return {
        policy: {
            surfaceId: 'aider',
            file: AIDER_CONFIG_FILE,
            model,
            autoCommits,
            dangerouslyAllowNonGit,
            dangerouslyAllowNonGitLine: dangerouslyAllowNonGit === true ? dangerous?.line : undefined,
            autoAcceptArchitect
        },
        findings: []
    };
}
/**
 * Minimal YAML reader: only top-level `key: value` scalar entries with
 * optional quoted strings and inline comments. Nested mappings, list
 * items (`- item`), block scalars (`|`, `>`), anchors, and flow-style
 * sequences are all ignored. Aider configs in the wild are flat
 * key-value, so this covers the practical surface without pulling in a
 * YAML dependency.
 */
function parseTopLevelYaml(text) {
    const entries = new Map();
    const lines = text.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
        const raw = lines[index];
        // Top-level keys have no leading whitespace.
        if (/^\s/.test(raw)) {
            continue;
        }
        const trimmed = raw.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }
        if (trimmed.startsWith('- ')) {
            continue;
        }
        const match = /^([A-Za-z0-9_.-]+)\s*:\s*(.*)$/.exec(trimmed);
        if (!match) {
            continue;
        }
        const key = match[1].toLowerCase();
        const rawValue = stripInlineComment(match[2]).trim();
        if (!rawValue) {
            // `key:` with no scalar — likely opens a nested block; ignore.
            continue;
        }
        const unquoted = unquote(rawValue);
        entries.set(key, { value: unquoted, line: index + 1 });
    }
    return entries;
}
function stripInlineComment(value) {
    let quote;
    let escape = false;
    for (let i = 0; i < value.length; i += 1) {
        const char = value[i];
        if (quote) {
            if (escape) {
                escape = false;
                continue;
            }
            if (char === '\\' && quote === '"') {
                escape = true;
                continue;
            }
            if (char === quote) {
                quote = undefined;
            }
            continue;
        }
        if (char === '"' || char === "'") {
            quote = char;
            continue;
        }
        if (char === '#') {
            return value.slice(0, i);
        }
    }
    return value;
}
function unquote(value) {
    if (value.length >= 2) {
        const first = value[0];
        const last = value[value.length - 1];
        if ((first === '"' || first === "'") && first === last) {
            return value.slice(1, -1);
        }
    }
    return value;
}
function readBoolean(value) {
    if (value === undefined) {
        return undefined;
    }
    const normalized = value.toLowerCase();
    if (['true', 'yes', 'on'].includes(normalized)) {
        return true;
    }
    if (['false', 'no', 'off'].includes(normalized)) {
        return false;
    }
    return undefined;
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
