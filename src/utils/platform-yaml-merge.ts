/**
 * Platform YAML Merge Utility
 * Reusable helper to merge platform-specific YAML frontmatter overrides
 * into universal markdown content.
 */

import { FILE_PATTERNS, PLATFORMS, UNIVERSAL_SUBDIRS, type Platform } from '../constants/index.js';
import type { FormulaFile } from '../types/index.js';
import { formulaManager } from '../core/formula.js';
import * as yaml from 'js-yaml';

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
    const overridePath = `${universalSubdir}/${base}.${targetPlatform}.yml`;
    const matchingYml = formulaFiles.find(f => f.path === overridePath);

    if (matchingYml?.content?.trim()) {
      try {
        // Parse the YAML override content
        const overrideData = yaml.load(matchingYml.content);

        // Convert back to YAML frontmatter format
        const frontmatterYaml = yaml.dump(overrideData, {
          indent: 2,
          noArrayIndent: true,
          sortKeys: false,
          quotingType: '"'
        }).trim();

        // Check if universal content already has frontmatter
        const trimmedContent = universalContent.trim();
        if (trimmedContent.startsWith('---')) {
          // Content already has frontmatter, merge with existing
          const endMarkerIndex = trimmedContent.indexOf('\n---', 3);
          if (endMarkerIndex !== -1) {
            // Extract existing frontmatter and content
            const existingFrontmatter = trimmedContent.substring(3, endMarkerIndex);
            const contentAfter = trimmedContent.substring(endMarkerIndex + 4);

            // Merge frontmatter: override YAML first, then existing
            const mergedFrontmatter = frontmatterYaml + '\n' + existingFrontmatter;
            return `---\n${mergedFrontmatter}\n---${contentAfter}`;
          }
        }

        // No existing frontmatter, prepend as new frontmatter
        return `---\n${frontmatterYaml}\n---\n\n${universalContent}`;
      } catch (error) {
        console.warn(`Failed to parse YAML override for ${overridePath}: ${error}`);
        // Fall back to universal content on error
      }
    }
  } catch {
    // Fall back to universal content on error
  }

  return universalContent;
}

/**
 * Load platform-specific YAML override files from the registry for a formula version.
 * Matches files in universal subdirs with pattern: "{subdir}/{base}.{platform}.yml"
 */
export async function loadRegistryYamlOverrides(
  formulaName: string,
  version: string
): Promise<FormulaFile[]> {
  const overrides: FormulaFile[] = [];

  // Load formula from registry
  const formula = await formulaManager.loadFormula(formulaName, version);

  // Known platforms for suffix matching
  const platformValues: string[] = Object.values(PLATFORMS as Record<string, string>);
  const subdirs: string[] = Object.values(UNIVERSAL_SUBDIRS as Record<string, string>);

  for (const file of formula.files) {
    const path = file.path;
    // Must be in a universal subdir
    if (!subdirs.some(sd => path.startsWith(sd + '/'))) continue;
    // Must end with .yml and have a platform suffix before it
    if (!path.endsWith(FILE_PATTERNS.YML_FILE)) continue;

    const lastDot = path.lastIndexOf('.');
    const secondLastDot = path.lastIndexOf('.', lastDot - 1);
    if (secondLastDot === -1) continue;
    const possiblePlatform = path.slice(secondLastDot + 1, lastDot);
    if (!platformValues.includes(possiblePlatform)) continue;

    overrides.push({ path: file.path, content: file.content, encoding: 'utf8' });
  }

  return overrides;
}


