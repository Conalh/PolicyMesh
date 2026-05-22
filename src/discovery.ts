import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  stripJsonComments,
  lineOfJsonKey as coreLineOfJsonKey,
  lineOfJsonStringValue as coreLineOfJsonStringValue,
} from 'agent-gov-core';

export async function readJsonObject(path: string): Promise<Record<string, unknown>> {
  return (await readJsonObjectWithSource(path)).json;
}

export interface JsonObjectSource {
  json: Record<string, unknown>;
  text: string;
  parseError?: JsonParseError;
}

export interface JsonParseError {
  message: string;
  line?: number;
}

export async function readJsonObjectWithSource(path: string): Promise<JsonObjectSource> {
  let raw = '';
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') {
      return { json: {}, text: '' };
    }

    throw error;
  }

  const stripped = stripJsonComments(raw);

  try {
    const parsed: unknown = JSON.parse(stripped);
    return { json: isRecord(parsed) ? parsed : {}, text: raw };
  } catch (error) {
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

export function configPath(root: string, relativePath: string): string {
  return join(root, relativePath);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function lineOfJsonKey(text: string, key: string): number | undefined {
  const line = coreLineOfJsonKey(text, key);
  return line === 0 ? undefined : line;
}

export function lineOfJsonStringValue(text: string, value: string): number | undefined {
  const line = coreLineOfJsonStringValue(text, value);
  return line === 0 ? undefined : line;
}

function lineOfJsonParseError(text: string, error: SyntaxError): number | undefined {
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

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
