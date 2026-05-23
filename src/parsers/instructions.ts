import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { configPath } from '../discovery.js';
import type { Finding, InstructionMatch, InstructionRiskCategory, InstructionsPolicy } from '../types.js';

const ROOT_FILES = [
  'AGENTS.md',
  'CLAUDE.md',
  '.github/copilot-instructions.md'
];

const CURSOR_RULES_DIR = '.cursor/rules';

/**
 * Deterministic, narrow regexes over imperative + risky-scope phrasing.
 * The bar is high enough that legitimate documentation (e.g. "Always use
 * TypeScript", "Never use var") does not trip. Each pattern requires
 * BOTH an imperative cue AND a phrase that names the safety property
 * being bypassed.
 */
const PATTERNS: { category: InstructionRiskCategory; regex: RegExp }[] = [
  // "without asking", "without confirmation", "without permission", "no need to ask"
  { category: 'skip_confirmation', regex: /\bwithout\s+(asking|confirm(?:ation|ing)?|prompt(?:ing)?|permission)\b/i },
  { category: 'skip_confirmation', regex: /\b(do not|don't|never)\s+(ask|confirm|prompt)\b/i },

  // "ignore deny rules", "bypass safety", "skip restrictions"
  { category: 'override_safety', regex: /\b(ignore|bypass|skip|override)\s+(the\s+)?(deny|denied|restrictions?|safety|security|guard(rails?)?|hooks?|protections?|checks?)\b/i },
  { category: 'override_safety', regex: /\bdisabled?\s+(the\s+)?(safety|guard(rails?)?|hooks?|denies?|checks?|protections?)\b/i },

  // "any file you want", "edit all files", "any path", "any directory"
  { category: 'broad_write', regex: /\b(any|all|every)\s+(file|files|directory|directories|path|paths)\b[^.]{0,80}\b(read|edit|write|modify|delete|change|update)\b/i },
  { category: 'broad_write', regex: /\b(read|edit|write|modify|delete|change|update)\b[^.]{0,80}\b(any|all|every)\s+(file|files|directory|directories|path|paths)\b/i },

  // "auto-commit", "auto-merge", "commit automatically", "push without review"
  { category: 'auto_version_control', regex: /\bauto[- ]?(commit|merge|push)\b/i },
  { category: 'auto_version_control', regex: /\b(commit|merge|push)\s+automatic(ally)?\b/i },
  { category: 'auto_version_control', regex: /\b(push|merge|commit)\s+without\s+review\b/i }
];

export async function parseInstructionsPolicy(root: string): Promise<{ policy?: InstructionsPolicy; findings: Finding[] }> {
  const files: string[] = [];
  const matches: InstructionMatch[] = [];

  // Top-level instruction files
  for (const relative of ROOT_FILES) {
    const found = await scanFile(root, relative, matches);
    if (found) {
      files.push(relative);
    }
  }

  // .cursor/rules/*.md or *.mdc
  try {
    const entries = await readdir(configPath(root, CURSOR_RULES_DIR), { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      if (!entry.name.endsWith('.md') && !entry.name.endsWith('.mdc')) {
        continue;
      }
      const relative = `${CURSOR_RULES_DIR}/${entry.name}`;
      const found = await scanFile(root, relative, matches);
      if (found) {
        files.push(relative);
      }
    }
  } catch (error) {
    // Directory missing is fine — Cursor rules are optional.
    if (!isMissingError(error)) {
      throw error;
    }
  }

  if (files.length === 0) {
    return { findings: [] };
  }

  return {
    policy: {
      surfaceId: 'instructions',
      files,
      matches
    },
    findings: []
  };
}

async function scanFile(root: string, relativePath: string, matches: InstructionMatch[]): Promise<boolean> {
  let text: string;
  try {
    text = await readFile(configPath(root, relativePath), 'utf8');
  } catch (error) {
    if (isMissingError(error)) {
      return false;
    }
    throw error;
  }

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const stripped = line.trim();
    if (!stripped || stripped.startsWith('<!--')) {
      continue;
    }

    // Each line can match at most one category; first matching pattern wins.
    for (const { category, regex } of PATTERNS) {
      if (regex.test(stripped)) {
        matches.push({
          file: relativePath,
          line: index + 1,
          category,
          excerpt: excerpt(stripped)
        });
        break;
      }
    }
  }

  return true;
}

function excerpt(line: string): string {
  const max = 100;
  return line.length <= max ? line : `${line.slice(0, max - 3)}...`;
}

function isMissingError(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}
