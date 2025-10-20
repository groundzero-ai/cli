/**
 * Root File Installer
 * Orchestrates installation of root files from registry to cwd
 */

import { join } from 'path';
import { exists, readTextFile, writeTextFile } from './fs.js';
import { getRootFilesFromRegistry } from './root-file-registry.js';
import { mergeFormulaContentIntoRootFile } from './root-file-merger.js';
import { logger } from './logger.js';
import { FILE_PATTERNS, type Platform } from '../constants/index.js';
import { getPlatformDefinition } from '../core/platforms.js';

/**
 * Result of root file installation
 */
export interface RootFileInstallResult {
  installed: string[];
  skipped: string[];
  updated: string[];
}

/**
 * Variant that installs root files from a preloaded map of path -> content
 */
export async function installRootFilesFromMap(
  cwd: string,
  formulaName: string,
  rootFilesMap: Map<string, string>,
  detectedPlatforms: Platform[]
): Promise<RootFileInstallResult> {
  const result: RootFileInstallResult = { installed: [], skipped: [], updated: [] };
  if (rootFilesMap.size === 0) return result;

  for (const platform of detectedPlatforms) {
    const platformDef = getPlatformDefinition(platform);
    if (!platformDef.rootFile) continue;

    // Prefer platform-specific, otherwise use AGENTS.md if present
    let content = rootFilesMap.get(platformDef.rootFile);
    let sourceFileName = platformDef.rootFile;
    if (!content && rootFilesMap.has(FILE_PATTERNS.AGENTS_MD)) {
      content = rootFilesMap.get(FILE_PATTERNS.AGENTS_MD)!;
      sourceFileName = FILE_PATTERNS.AGENTS_MD;
    }
    if (!content) continue;

    try {
      const wasUpdated = await installSingleRootFile(cwd, platformDef.rootFile, formulaName, content);
      if (wasUpdated) result.updated.push(platformDef.rootFile);
      else result.installed.push(platformDef.rootFile);
      logger.debug(`Installed root file ${platformDef.rootFile} for ${formulaName} (from ${sourceFileName})`);
    } catch (error) {
      logger.error(`Failed to install root file ${platformDef.rootFile}: ${error}`);
      result.skipped.push(platformDef.rootFile);
    }
  }

  return result;
}


/**
 * Install or update a single root file at cwd root.
 * Preserves existing content and merges formula section using markers.
 * 
 * @param cwd - Current working directory
 * @param rootFileName - Name of the root file (e.g., 'CLAUDE.md')
 * @param formulaName - Name of the formula
 * @param registryContent - Content from the registry to merge
 * @returns True if file was updated (existed before), false if newly created
 */
async function installSingleRootFile(
  cwd: string,
  rootFileName: string,
  formulaName: string,
  registryContent: string
): Promise<boolean> {
  const targetPath = join(cwd, rootFileName);
  
  // Read existing content or start with empty string
  let existingContent = '';
  let wasExisting = false;
  
  if (await exists(targetPath)) {
    existingContent = await readTextFile(targetPath);
    wasExisting = true;
  }

  // Merge formula content into the file
  const mergedContent = mergeFormulaContentIntoRootFile(
    existingContent,
    formulaName,
    registryContent
  );

  // Write the merged content
  await writeTextFile(targetPath, mergedContent);

  return wasExisting;
}


