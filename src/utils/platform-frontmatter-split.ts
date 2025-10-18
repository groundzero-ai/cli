/**
 * Platform Frontmatter Split Utilities
 * Handles splitting platform-specific files into universal + platform-specific pieces
 */

import { basename } from 'path';
import { parseMarkdownFrontmatter, extractNonFormulaFrontmatter, removeNonFormulaFrontmatter, updateMarkdownWithFormulaFrontmatter } from './md-frontmatter.js';
import { writeTextFile, readTextFile } from './fs.js';
import { FILE_PATTERNS, PLATFORM_DIRS, PLATFORMS } from '../constants/index.js';
import type { DiscoveredFile, FormulaYml, FormulaFile } from '../types/index.js';

/**
 * Split a platform-specific file's frontmatter if eligible.
 * Returns array of FormulaFiles (universal md + optional platform yml) or null if not applicable.
 */
export async function splitPlatformFileFrontmatter(
  mdFile: DiscoveredFile,
  formulaConfig: FormulaYml,
  rootFilenamesSet: Set<string>,
  logPrefix: string
): Promise<FormulaFile[] | null> {
  // Only for platform directories (not ai), non-root files, not marked as platformSpecific
  try {
    const originalContent = await readTextFile(mdFile.fullPath);
    const fm = parseMarkdownFrontmatter(originalContent);

    const isPlatformDir = mdFile.sourceDir !== PLATFORM_DIRS.AI;
    const isMarkedPlatformSpecific = fm?.formula?.platformSpecific === true;
    const isRootFile = rootFilenamesSet.has(basename(mdFile.fullPath));

    if (!isPlatformDir || isMarkedPlatformSpecific || isRootFile) {
      return null;
    }

    const nonFormulaYaml = extractNonFormulaFrontmatter(originalContent);
    if (!nonFormulaYaml || !nonFormulaYaml.trim().length) {
      return null;
    }

    // 1) Ensure workspace file has correct formula id/name (only patch formula frontmatter)
    const workspaceUpdated = updateMarkdownWithFormulaFrontmatter(originalContent, {
      name: formulaConfig.name,
      ensureId: true
    });

    if (workspaceUpdated !== originalContent) {
      await writeTextFile(mdFile.fullPath, workspaceUpdated);
      console.log(`${logPrefix} ${mdFile.relativePath}`);
    }

    // 2) Build universal content (formula-only) for registry
    const universalContent = removeNonFormulaFrontmatter(workspaceUpdated);

    // 3) Create YAML override alongside universal file in registry
    // Use platform ID (e.g., 'cursor'), not directory name (e.g., '.cursor') for suffix
    const platformId = (() => {
      for (const key of Object.keys(PLATFORM_DIRS) as Array<keyof typeof PLATFORM_DIRS>) {
        if (PLATFORM_DIRS[key] === mdFile.sourceDir) {
          return (PLATFORMS as any)[key] as string;
        }
      }
      // Fallback: strip leading dot if no exact match
      return mdFile.sourceDir.replace(/^\./, '');
    })();

    const yamlRegistryPath = mdFile.registryPath.endsWith(FILE_PATTERNS.MD_FILES)
      ? mdFile.registryPath.slice(0, -FILE_PATTERNS.MD_FILES.length) + `.${platformId}.yml`
      : `${mdFile.registryPath}.${platformId}.yml`;

    return [
      {
        path: mdFile.registryPath,
        content: universalContent,
        encoding: 'utf8'
      },
      {
        path: yamlRegistryPath,
        content: nonFormulaYaml.trimEnd(),
        encoding: 'utf8'
      }
    ];
  } catch {
    return null;
  }
}
