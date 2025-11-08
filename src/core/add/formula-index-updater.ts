import { dirname, join } from 'path';
import { exists } from '../../utils/fs.js';
import { logger } from '../../utils/logger.js';
import { parseFormulaYml } from '../../utils/formula-yml.js';
import {
  getFormulaIndexPath,
  readFormulaIndex,
  writeFormulaIndex,
  type FormulaIndexRecord,
  sortMapping
} from '../../utils/formula-index-yml.js';
import {
  buildIndexMappingForFormulaFiles,
  loadOtherFormulaIndexes
} from '../../utils/index-based-installer.js';
import { getLocalFormulaDir } from '../../utils/paths.js';
import type { FormulaFile } from '../../types/index.js';
import { PLATFORM_DIRS, type Platform } from '../../constants/index.js';
import { parseUniversalPath } from '../../utils/platform-file.js';
import { mapUniversalToPlatform } from '../../utils/platform-mapper.js';

/**
 * Compute the directory key (registry side) to collapse file mappings under.
 * Mirrors the grouping behavior used by install/index mapping logic.
 */
export function computeDirKeyFromRegistryPath(registryPath: string): string {
  const normalized = registryPath.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  const parts = normalized.split('/');
  if (parts.length <= 1) return '';
  const universal = new Set<string>(['ai', 'rules', 'commands', 'agents', 'skills']);
  if (universal.has(parts[0])) {
    if (parts.length >= 2) return `${parts[0]}/${parts[1]}/`;
    return `${parts[0]}/`;
  }
  const idx = normalized.lastIndexOf('/');
  if (idx === -1) return '';
  return normalized.substring(0, idx + 1);
}

/**
 * Prune nested child directories if their parent directory is already present.
 * Example: keep "skills/nestjs/" and drop "skills/nestjs/examples/".
 */
export function pruneNestedDirectories(dirs: string[]): string[] {
  const sorted = [...dirs].sort((a, b) => {
    if (a.length === b.length) {
      return a.localeCompare(b);
    }
    return a.length - b.length;
  });

  const pruned: string[] = [];
  for (const dir of sorted) {
    const hasParent = pruned.some(parent => dir !== parent && dir.startsWith(parent));
    if (!hasParent) {
      pruned.push(dir);
    }
  }
  return pruned;
}

/**
 * Prune stale keys from previous index that no longer exist in current files.
 * File keys are kept only if the exact file path exists in currentFiles.
 * Directory keys are kept only if at least one current file path starts with that directory prefix.
 */
function pruneStaleKeysByCurrentFiles(
  previous: Record<string, string[]>,
  currentFiles: string[]
): Record<string, string[]> {
  // Normalize to forward slashes for consistent comparisons
  const normalizedCurrent = currentFiles.map(p => p.replace(/\\/g, '/'));
  const currentSet = new Set(normalizedCurrent);

  const result: Record<string, string[]> = {};
  for (const [rawKey, values] of Object.entries(previous)) {
    const key = rawKey.replace(/\\/g, '/');

    if (key.endsWith('/')) {
      // Keep dir keys only if at least one current file is under that directory
      if (normalizedCurrent.some(p => p.startsWith(key))) {
        result[key] = values;
      }
    } else {
      // Keep file keys only if that exact file still exists
      if (currentSet.has(key)) {
        result[key] = values;
      }
    }
  }
  return result;
}

/**
 * Merge new mapping updates with existing index, respecting existing entries.
 * For directory keys (ending with /), prunes redundant nested child directories
 * to prevent adding subdirectories when a parent directory already exists.
 */
function mergeMappingsRespectingExisting(
  previous: Record<string, string[]>,
  updates: Record<string, string[]>
): Record<string, string[]> {
  const merged: Record<string, string[]> = { ...previous };

  for (const [key, newVals] of Object.entries(updates)) {
    const prevVals = merged[key] || [];
    // Union + de-dupe
    const union = Array.from(new Set([...prevVals, ...newVals]));

    // For directory keys, prune nested child dirs if parent is present
    if (key.endsWith('/')) {
      merged[key] = pruneNestedDirectories(union).sort();
    } else {
      merged[key] = union.sort();
    }
  }

  return sortMapping(merged);
}

/**
 * Collapse file entries into directory keys when appropriate.
 * Groups file entries by their directory key and automatically collapses them into dir key entries.
 * This is universally applied to all eligible groups to ensure consistent index structure.
 */
function collapseFileEntriesToDirKeys(
  mapping: Record<string, string[]>
): Record<string, string[]> {
  const collapsed: Record<string, string[]> = {};
  const dirKeyGroups = new Map<string, Array<{ key: string; values: string[] }>>();

  // Group file entries by their directory key
  for (const [key, values] of Object.entries(mapping)) {
    // Skip directory keys (they already end with /)
    if (key.endsWith('/')) {
      collapsed[key] = values;
      continue;
    }

    const dirKey = computeDirKeyFromRegistryPath(key);
    if (!dirKey) {
      // No dir key possible, keep as file entry
      collapsed[key] = values;
      continue;
    }

    if (!dirKeyGroups.has(dirKey)) {
      dirKeyGroups.set(dirKey, []);
    }
    dirKeyGroups.get(dirKey)!.push({ key, values });
  }

  // Process each directory group - always collapse when multiple files share a dir key
  for (const [dirKey, entries] of dirKeyGroups.entries()) {
    // Collapse: collect all installed directories from file entries
    const dirValues = new Set<string>();
    for (const entry of entries) {
      for (const v of entry.values) {
        const d = dirname(v);
        if (d && d !== '.') {
          const normalized = d.endsWith('/') ? d : `${d}/`;
          dirValues.add(normalized);
        }
      }
    }

    if (dirValues.size > 0) {
      // Replace file entries with a single dir key entry
      const pruned = pruneNestedDirectories(Array.from(dirValues));
      collapsed[dirKey] = pruned.sort();
    } else {
      // No directories found, keep as individual file entries
      for (const entry of entries) {
        collapsed[entry.key] = entry.values;
      }
    }
  }

  return sortMapping(collapsed);
}

/**
 * Build mapping from FormulaFile[] and write/merge to formula.index.yml.
 * Automatically collapses file entries into directory keys when appropriate.
 */
export interface BuildIndexOptions {
  /**
   * When true, do not collapse file entries into directory keys.
   * Keeps exact file paths as keys in formula.index.yml.
   */
  preserveExactPaths?: boolean;
}

/**
 * Build a mapping that preserves exact file keys for the provided formulaFiles.
 * For universal subdirs, maps to platform-specific installed paths using detected platforms.
 * For ai/ paths and other non-universal paths, keeps the value as the same path.
 */
function buildExactFileMapping(
  formulaFiles: FormulaFile[],
  platforms: Platform[]
): Record<string, string[]> {
  const mapping: Record<string, string[]> = {};

  for (const file of formulaFiles) {
    const key = file.path.replace(/\\/g, '/');
    const values = new Set<string>();

    // ai/ paths: keep as-is
    if (key.startsWith(`${PLATFORM_DIRS.AI}/`)) {
      values.add(key);
    } else {
      const parsed = parseUniversalPath(key);
      if (parsed) {
        // Map universal files across provided platforms
        for (const platform of platforms) {
          try {
            const { absFile } = mapUniversalToPlatform(platform, parsed.universalSubdir as any, parsed.relPath);
            values.add(absFile.replace(/\\/g, '/'));
          } catch {
            // Skip platforms that don't support this subdir
          }
        }
      } else {
        // Fallback: keep value as the same path
        values.add(key);
      }
    }

    mapping[key] = Array.from(values).sort();
  }

  return mapping;
}

export async function buildMappingAndWriteIndex(
  cwd: string,
  formulaName: string,
  formulaFiles: FormulaFile[],
  platforms: Platform[],
  options: BuildIndexOptions = {}
): Promise<void> {
  try {
    // Read existing index and other indexes for conflict context
    const previousIndex = await readFormulaIndex(cwd, formulaName);
    const otherIndexes = await loadOtherFormulaIndexes(cwd, formulaName);

    // Resolve version (prefer previous index; otherwise read from formula.yml)
    let version = previousIndex?.version || '';
    if (!version) {
      const formulaDir = getLocalFormulaDir(cwd, formulaName);
      const formulaYmlPath = join(formulaDir, 'formula.yml');
      if (await exists(formulaYmlPath)) {
        try {
          const formulaYml = await parseFormulaYml(formulaYmlPath);
          version = formulaYml.version;
        } catch (error) {
          logger.warn(`Failed to read formula.yml for version: ${error}`);
          return;
        }
      }
    }

    if (!version) {
      logger.debug(`No version found for ${formulaName}, skipping index update`);
      return;
    }

    // Build mapping using same flow as install
    let newMapping = await buildIndexMappingForFormulaFiles(
      cwd,
      formulaFiles,
      platforms,
      previousIndex,
      otherIndexes
    );

    // Optionally transform mapping:
    // - If preserveExactPaths is true: force exact file keys and strip dir keys
    // - Otherwise: allow directory collapsing
    if (options.preserveExactPaths) {
      newMapping = buildExactFileMapping(formulaFiles, platforms);
    } else {
      newMapping = collapseFileEntriesToDirKeys(newMapping);
    }

    // Prune stale keys from previous index based on current files in .groundzero
    // This ensures keys are updated when files/directories are moved or renamed
    const currentPaths = formulaFiles.map(f => f.path);
    const prunedPreviousFiles = pruneStaleKeysByCurrentFiles(
      previousIndex?.files || {},
      currentPaths
    );

    // Merge and write index - respect existing entries (post-pruning) and prune redundant children
    const mergedFiles = mergeMappingsRespectingExisting(
      prunedPreviousFiles,
      newMapping
    );
    const indexRecord: FormulaIndexRecord = {
      path: getFormulaIndexPath(cwd, formulaName),
      formulaName,
      version,
      files: mergedFiles
    };
    await writeFormulaIndex(indexRecord);
    logger.debug(`Updated formula.index.yml for ${formulaName}@${version}`);
  } catch (error) {
    logger.warn(`Failed to update formula.index.yml for ${formulaName}: ${error}`);
  }
}


