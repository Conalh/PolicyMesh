import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
export async function readJsonObject(path) {
    return (await readJsonObjectWithSource(path)).json;
}
export async function readJsonObjectWithSource(path) {
    let raw = '';
    try {
        raw = await readFile(path, 'utf8');
    }
    catch (error) {
        if (isNodeError(error) && error.code === 'ENOENT') {
            return { json: {}, text: '' };
        }
        throw error;
    }
    const stripped = stripJsonComments(raw);
    try {
        const parsed = JSON.parse(stripped);
        return { json: isRecord(parsed) ? parsed : {}, text: raw };
    }
    catch (error) {
        if (error instanceof SyntaxError) {
            return {
                json: {},
                text: raw,
                parseError: {
                    message: error.message,
                    line: lineOfJsonParseError(stripped, error)
                }
            };
        }
        throw error;
    }
}
// VS Code and Cursor both ship MCP configs as JSONC — comments and the
// occasional trailing comma are normal, not malformed. We strip them
// before JSON.parse so those files audit cleanly. Replacing comment
// bytes with spaces (and preserving newlines in block comments) keeps
// the original byte/line positions intact for error reporting and the
// downstream line locators in lineOfJsonKey / lineOfJsonStringValue.
function stripJsonComments(raw) {
    let out = '';
    let inString = false;
    let escape = false;
    for (let index = 0; index < raw.length; index += 1) {
        const char = raw[index];
        const next = raw[index + 1];
        if (inString) {
            out += char;
            if (escape) {
                escape = false;
            }
            else if (char === '\\') {
                escape = true;
            }
            else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
            out += char;
            continue;
        }
        if (char === '/' && next === '/') {
            while (index < raw.length && raw[index] !== '\n') {
                out += ' ';
                index += 1;
            }
            // restore loop invariant: the for-loop's index++ will advance past '\n'
            if (index < raw.length) {
                out += raw[index];
            }
            continue;
        }
        if (char === '/' && next === '*') {
            out += '  ';
            index += 2;
            while (index < raw.length && !(raw[index] === '*' && raw[index + 1] === '/')) {
                out += raw[index] === '\n' ? '\n' : ' ';
                index += 1;
            }
            if (index < raw.length) {
                out += '  ';
                index += 1; // for-loop will advance past the '/'
            }
            continue;
        }
        out += char;
    }
    return stripTrailingCommas(out);
}
// Trailing commas before `]` or `}` are legal in JSONC; JSON.parse rejects
// them. Removing them after comment-stripping keeps byte positions stable
// because we replace each removed comma with a space.
function stripTrailingCommas(raw) {
    let out = '';
    let inString = false;
    let escape = false;
    for (let index = 0; index < raw.length; index += 1) {
        const char = raw[index];
        if (inString) {
            out += char;
            if (escape) {
                escape = false;
            }
            else if (char === '\\') {
                escape = true;
            }
            else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
            out += char;
            continue;
        }
        if (char === ',') {
            let look = index + 1;
            while (look < raw.length && /\s/.test(raw[look])) {
                look += 1;
            }
            if (raw[look] === ']' || raw[look] === '}') {
                out += ' ';
                continue;
            }
        }
        out += char;
    }
    return out;
}
export function configPath(root, relativePath) {
    return join(root, relativePath);
}
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function lineOfJsonKey(text, key) {
    const keyPattern = new RegExp(`"${escapeRegExp(key)}"\\s*:`);
    return lineOfPattern(text, keyPattern);
}
export function lineOfJsonStringValue(text, value) {
    const encoded = JSON.stringify(value);
    return lineOfPattern(text, new RegExp(escapeRegExp(encoded)));
}
function lineOfPattern(text, pattern) {
    const lines = text.split(/\r?\n/);
    const index = lines.findIndex((line) => pattern.test(line));
    return index === -1 ? undefined : index + 1;
}
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function lineOfJsonParseError(text, error) {
    const positionMatch = /position (\d+)/.exec(error.message);
    if (!positionMatch) {
        return undefined;
    }
    const position = Number(positionMatch[1]);
    if (!Number.isInteger(position) || position < 0) {
        return undefined;
    }
    return text.slice(0, position).split(/\r?\n/).length;
}
function isNodeError(error) {
    return error instanceof Error && 'code' in error;
}
