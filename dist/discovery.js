import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stripJsonComments, lineOfJsonKey as coreLineOfJsonKey, lineOfJsonStringValue as coreLineOfJsonStringValue, } from 'agent-gov-core';
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
export function configPath(root, relativePath) {
    return join(root, relativePath);
}
export function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
export function lineOfJsonKey(text, key) {
    const line = coreLineOfJsonKey(text, key);
    return line === 0 ? undefined : line;
}
export function lineOfJsonStringValue(text, value) {
    const line = coreLineOfJsonStringValue(text, value);
    return line === 0 ? undefined : line;
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
