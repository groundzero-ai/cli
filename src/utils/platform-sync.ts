/**
 * Platform Sync Module
 * Utility functions for syncing saved formula files across detected platforms
 */

import { relative, join, dirname, basename } from 'path';
import { ensureDir, writeTextFile, exists, readTextFile } from './fs.js';
import { getDetectedPlatforms, getPlatformDefinition } from '../core/platforms.js';
import { resolveInstallTargets } from './platform-mapper.js';
import { FILE_PATTERNS } from '../constants/index.js';
import { logger } from './logger.js';
import type { FormulaFile } from '../types/index.js';
import { parseUniversalPath } from './platform-file.js';
import { mergePlatformYamlOverride } from './platform-yaml-merge.js';

/**
 * Result of platform sync operation
 */
export interface PlatformSyncResult {
  created: string[];
  updated: string[];
}

/**
 * Determine if a formula file is syncable across platforms.
 * - Allows universal subdir .md files
 * - Allows index.yml under universal subdirs
 */
function isSyncableUniversalFile(file: FormulaFile): boolean {
  const parsed = parseUniversalPath(file.path);
  if (!parsed) return false;
  if (file.path.endsWith(FILE_PATTERNS.MD_FILES)) return true;
  return basename(parsed.relPath) === 'index.yml';
}

/**
 * Sync an index.yml file verbatim across detected platforms for a universal subdir
 */
async function syncIndexYmlAcrossPlatforms(
  cwd: string,
  universalSubdir: string,
  relPath: string,
  content: string,
  detectedPlatforms: string[],
  result: PlatformSyncResult
): Promise<void> {
  for (const platform of detectedPlatforms) {
    const def = getPlatformDefinition(platform as any);
    const universalSubdirKey = universalSubdir as keyof typeof def.subdirs;
    const subdirDef = def.subdirs[universalSubdirKey];
    if (!subdirDef) continue; // Platform doesn't support this subdir

    const absDir = join(cwd, def.rootDir, subdirDef.path);
    const absFile = join(absDir, relPath);

    await ensureDir(dirname(absFile));

    const fileExists = await exists(absFile);
    let existingContent = '';
    if (fileExists) {
      try {
        existingContent = await readTextFile(absFile, 'utf8');
      } catch (error) {
        logger.warn(`Failed to read existing file ${absFile}: ${error}`);
      }
    }

    await writeTextFile(absFile, content, 'utf8');

    const rel = relative(cwd, absFile);
    if (fileExists) {
      if (existingContent !== content) {
        result.updated.push(rel);
        logger.debug(`Updated synced file: ${absFile}`);
      } else {
        logger.debug(`Synced file unchanged: ${absFile}`);
      }
    } else {
      result.created.push(rel);
      logger.debug(`Created synced file: ${absFile}`);
    }
  }
}

/**
 * Sync a universal markdown file with optional YAML override merging
 */
async function syncUniversalMarkdown(
  cwd: string,
  universalSubdir: string,
  relPath: string,
  content: string,
  formulaFiles: FormulaFile[],
  result: PlatformSyncResult
): Promise<void> {
  const { resolveInstallTargets } = await import('./platform-mapper.js');
  const targets = await resolveInstallTargets(cwd, {
    universalSubdir: universalSubdir as any,
    relPath,
    sourceExt: FILE_PATTERNS.MD_FILES
  });

  for (const target of targets) {
    await ensureDir(target.absDir);

    const fileExists = await exists(target.absFile);
    let existingContent = '';
    if (fileExists) {
      try {
        existingContent = await readTextFile(target.absFile, 'utf8');
      } catch (error) {
        logger.warn(`Failed to read existing file ${target.absFile}: ${error}`);
      }
    }

    const finalContent = mergePlatformOverrideContent(
      content,
      target.platform,
      universalSubdir,
      relPath,
      formulaFiles
    );

    await writeTextFile(target.absFile, finalContent, 'utf8');

    const rel = relative(cwd, target.absFile);
    if (fileExists) {
      if (existingContent !== finalContent) {
        result.updated.push(rel);
        logger.debug(`Updated synced file: ${target.absFile}`);
      } else {
        logger.debug(`Synced file unchanged: ${target.absFile}`);
      }
    } else {
      result.created.push(rel);
      logger.debug(`Created synced file: ${target.absFile}`);
    }
  }
}

/**
 * Merge platform-specific YAML override with universal content
 */
function mergePlatformOverrideContent(
  universalContent: string,
  targetPlatform: string,
  universalSubdir: string,
  relPath: string,
  formulaFiles: FormulaFile[]
): string {
  return mergePlatformYamlOverride(
    universalContent,
    targetPlatform as any,
    universalSubdir,
    relPath,
    formulaFiles
  );
}


/**
 * Sync saved formula files across all detected platforms
 * @param cwd - Current working directory
 * @param formulaFiles - Array of formula files that were saved to registry
 * @returns Promise resolving to sync result with created files
 */
export async function postSavePlatformSync(
  cwd: string,
  formulaFiles: FormulaFile[]
): Promise<PlatformSyncResult> {
  const result: PlatformSyncResult = {
    created: [],
    updated: []
  };

  // Get detected platforms
  const detectedPlatforms = await getDetectedPlatforms(cwd);

  if (detectedPlatforms.length === 0) {
    logger.debug('No platforms detected, skipping platform sync');
    return result;
  }

  // Filter formula files to only those in universal subdirs (rules, commands, agents)
  // Include .md files and index.yml (copied verbatim), but exclude other .yml overrides
  const syncableFiles = formulaFiles.filter(isSyncableUniversalFile);

  if (syncableFiles.length === 0) {
    logger.debug('No syncable files found (no universal subdir files), skipping platform sync');
    return result;
  }

  logger.debug(`Starting platform sync for ${syncableFiles.length} files across ${detectedPlatforms.length} platforms`);

  // Process each syncable file
  for (const file of syncableFiles) {
    const parsedPath = parseUniversalPath(file.path);
    if (!parsedPath) continue;

    // Skip platform-specific files entirely (those with a platform suffix in filename)
    if (parsedPath.platformSuffix) {
      continue;
    }

    // Sync non platform-specific files across detected platforms
    const { universalSubdir, relPath } = parsedPath;

    // Special case: index.yml should be copied as-is without extension transforms or merges
    const isIndexYml = basename(relPath) === 'index.yml';

    try {
      if (isIndexYml) {
        await syncIndexYmlAcrossPlatforms(
          cwd,
          universalSubdir,
          relPath,
          file.content,
          detectedPlatforms,
          result
        );
      } else {
        await syncUniversalMarkdown(
          cwd,
          universalSubdir,
          relPath,
          file.content,
          formulaFiles,
          result
        );
      }
    } catch (error) {
      logger.warn(`Failed to sync file ${file.path}: ${error}`);
    }
  }

  return result;
}
