import { normalizePathForProcessing } from './path-normalization.js';
import { PACKAGE_INDEX_FILENAME } from './package-index-yml.js';
import { DIR_PATTERNS, OPENPACKAGE_DIRS } from '../constants/index.js';

const EXCLUDED_DIR_PREFIXES = [
  'packages', // Nested packages are independent units; never copy inline
  `${DIR_PATTERNS.OPENPACKAGE}/${OPENPACKAGE_DIRS.PACKAGES}` // Current nested package layout under .openpackage/
];

const EXCLUDED_FILES = new Set<string>([PACKAGE_INDEX_FILENAME]);

export interface PackageFilterConfig {
  include?: string[];
  exclude?: string[];
}

type PathFilter = (relativePath: string) => boolean;

const MATCH_ALL: PathFilter = () => true;
const SPECIAL_REGEX_CHARS = /[\\^$+?.()|[\]{}]/g;

function escapeRegexCharacter(segment: string): string {
  return segment.replace(SPECIAL_REGEX_CHARS, '\\$&');
}

function normalizePattern(rawPattern: string): string | null {
  if (typeof rawPattern !== 'string') {
    return null;
  }
  let pattern = rawPattern.trim();
  if (pattern.length === 0) {
    return null;
  }

  pattern = pattern.replace(/\\/g, '/');
  pattern = pattern.replace(/^\.\/+/, '');
  pattern = pattern.replace(/^\/+/, '');
  pattern = pattern.replace(/\/+/g, '/');

  if (pattern.length === 0) {
    return null;
  }

  if (pattern.endsWith('/')) {
    pattern = `${pattern}**`;
  }

  return pattern;
}

function globToRegExp(pattern: string): RegExp {
  let regex = '^';

  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];

    if (char === '*') {
      const nextChar = pattern[i + 1];
      if (nextChar === '*') {
        const slashChar = pattern[i + 2];
        if (slashChar === '/') {
          regex += '(?:.*/)?';
          i += 2;
        } else {
          regex += '.*';
          i += 1;
        }
      } else {
        regex += '[^/]*';
      }
      continue;
    }

    if (char === '?') {
      regex += '[^/]';
      continue;
    }

    regex += escapeRegexCharacter(char);
  }

  regex += '$';
  return new RegExp(regex);
}

function compilePatterns(patterns?: string[]): RegExp[] {
  if (!patterns) {
    return [];
  }
  const compiled: RegExp[] = [];

  for (const rawPattern of patterns) {
    const normalized = normalizePattern(rawPattern);
    if (!normalized) {
      continue;
    }
    try {
      compiled.push(globToRegExp(normalized));
    } catch {
      // Skip invalid patterns to avoid blocking save/pack flows.
    }
  }

  return compiled;
}

function matches(path: string, patterns: RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(path));
}

export function isExcludedFromPackage(relativePath: string): boolean {
  const normalized = normalizePathForProcessing(relativePath);
  if (!normalized) {
    return true;
  }

  const baseName = normalized.split('/').pop();
  if (baseName && EXCLUDED_FILES.has(baseName)) {
    return true;
  }

  return EXCLUDED_DIR_PREFIXES.some(prefix => {
    const normalizedPrefix = normalizePathForProcessing(prefix);
    return (
      normalized === normalizedPrefix ||
      normalized.startsWith(`${normalizedPrefix}/`)
    );
  });
}

export function createPackageFileFilter(config?: PackageFilterConfig): PathFilter {
  if (!config) {
    return MATCH_ALL;
  }

  const includePatterns = compilePatterns(config.include);
  const excludePatterns = compilePatterns(config.exclude);
  const hasInclude = includePatterns.length > 0;

  if (!hasInclude && excludePatterns.length === 0) {
    return MATCH_ALL;
  }

  return (relativePath: string) => {
    const normalized = normalizePathForProcessing(relativePath);
    if (!normalized) {
      return false;
    }

    if (hasInclude && !matches(normalized, includePatterns)) {
      return false;
    }

    if (excludePatterns.length > 0 && matches(normalized, excludePatterns)) {
      return false;
    }

    return true;
  };
}

