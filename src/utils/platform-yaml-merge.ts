/**
 * Platform YAML Merge Utility
 * Reusable helper to merge platform-specific YAML frontmatter overrides
 * into universal markdown content.
 */

import { FILE_PATTERNS, type Platform } from '../constants/index.js';
import type { FormulaFile } from '../types/index.js';
import { mergeFrontmatter } from './md-frontmatter.js';

/**
 * Merge platform-specific YAML override with universal content.
 *
 * - Only acts on markdown files (relPath must end with .md)
 * - Looks for `{universalSubdir}/{base}.{platform}.yml` in the provided files
 * - If found, merges YAML (non-formula) before the formula block
 * - Returns original content if no matching override
 */
export function mergePlatformYamlOverride(
  universalContent: string,
  targetPlatform: Platform,
  universalSubdir: string,
  relPath: string,
  formulaFiles: FormulaFile[]
): string {
  try {
    if (!relPath.endsWith(FILE_PATTERNS.MD_FILES)) return universalContent;

    const base = relPath.slice(0, -FILE_PATTERNS.MD_FILES.length);
    const candidates = [
      `${universalSubdir}/${base}.${targetPlatform}.yml`,
      // Legacy double-dot variant from earlier bug
      `${universalSubdir}/${base}..${targetPlatform}.yml`
    ];
    const matchingYml = formulaFiles.find(f => candidates.includes(f.path));

    if (matchingYml?.content?.trim()) {
      return mergeFrontmatter(universalContent, matchingYml.content);
    }
  } catch {
    // Fall back to universal content on error
  }

  return universalContent;
}


