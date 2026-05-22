export interface SecretMatch {
  provider: string;
}

interface SecretPattern {
  provider: string;
  regex: RegExp;
  /**
   * When true, the pattern is only applied to env / header values, not
   * to launch commands. Used for shapes that produce false positives
   * inside command arguments — e.g. a 40-char hex commit SHA passed as
   * a positional arg is indistinguishable from a hex token.
   */
  envHeaderOnly?: boolean;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { provider: 'Anthropic', regex: /sk-ant-[A-Za-z0-9_-]{20,}/ },
  { provider: 'OpenAI', regex: /sk-proj-[A-Za-z0-9_-]{20,}/ },
  { provider: 'OpenAI', regex: /sk-(?!ant-|proj-)[A-Za-z0-9]{32,}/ },
  { provider: 'GitHub', regex: /gh[pousr]_[A-Za-z0-9]{36,}/ },
  { provider: 'GitHub', regex: /github_pat_[A-Za-z0-9_]{20,}/ },
  { provider: 'Slack', regex: /xox[abprs]-[A-Za-z0-9-]{20,}/ },
  { provider: 'AWS', regex: /AKIA[0-9A-Z]{16}/ },
  { provider: 'Google', regex: /AIza[0-9A-Za-z_-]{35}/ },
  { provider: 'GitLab', regex: /glpat-[A-Za-z0-9_-]{20,}/ },
  { provider: 'npm', regex: /npm_[A-Za-z0-9]{36}/ },
  { provider: 'Docker', regex: /dckr_pat_[A-Za-z0-9_-]{20,}/ },
  { provider: 'Stripe', regex: /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/ },
  // Restricted to env/header context to avoid flagging commit SHAs or
  // checksums passed as positional command arguments. A bare 40+ char
  // hex blob in an env value is almost always a credential.
  { provider: 'Hex token', regex: /(?:^|[^A-Fa-f0-9])([A-Fa-f0-9]{40,})(?:$|[^A-Fa-f0-9])/, envHeaderOnly: true },
];

/**
 * Values starting with this prefix are environment-variable references
 * (the safe pattern). They must not be scanned as if they were literals.
 * Codex uses `env:VAR` directly; we normalise that into headers/env values
 * during parsing.
 */
const ENV_REFERENCE_PREFIX = 'env:';

export interface MatchSecretOptions {
  /**
   * When true, patterns flagged `envHeaderOnly` are eligible. Set this
   * only when scanning env or header values — never when scanning a
   * joined launch command.
   */
  envOrHeaderContext?: boolean;
}

export function matchSecret(value: string, options: MatchSecretOptions = {}): SecretMatch | undefined {
  if (!value) {
    return undefined;
  }

  if (value.startsWith(ENV_REFERENCE_PREFIX)) {
    return undefined;
  }

  for (const pattern of SECRET_PATTERNS) {
    if (pattern.envHeaderOnly && !options.envOrHeaderContext) {
      continue;
    }
    if (pattern.regex.test(value)) {
      return { provider: pattern.provider };
    }
  }

  return undefined;
}
