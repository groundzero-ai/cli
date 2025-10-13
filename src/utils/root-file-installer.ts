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
import { getAllPlatforms, getPlatformDefinition } from '../core/platforms.js';

/**
 * Result of root file installation
 */
export interface RootFileInstallResult {
  installed: string[];
  skipped: string[];
  updated: string[];
}

/**
 * Install root files for a formula from the local registry to cwd.
 * Preserves existing content and merges formula-specific sections using markers.
 * 
 * @param cwd - Current working directory (project root)
 * @param formulaName - Name of the formula
 * @param version - Version of the formula
 * @param detectedPlatforms - List of detected platforms in the project
 * @returns Installation results with lists of installed, updated, and skipped files
 */
export async function installRootFiles(
  cwd: string,
  formulaName: string,
  version: string,
  detectedPlatforms: Platform[]
): Promise<RootFileInstallResult> {
  const result: RootFileInstallResult = {
    installed: [],
    skipped: [],
    updated: []
  };

  // Get all root files from registry for this formula
  const rootFilesMap = await getRootFilesFromRegistry(formulaName, version);

  if (rootFilesMap.size === 0) {
    logger.debug(`No root files found in registry for ${formulaName}@${version}`);
    return result;
  }

  // Process each detected platform - install appropriate root file content
  for (const platform of detectedPlatforms) {
    const platformDef = getPlatformDefinition(platform);
    if (!platformDef.rootFile) continue;

    // Get content: prefer platform-specific, fallback to universal AGENTS.md
    let content = rootFilesMap.get(platformDef.rootFile);
    let sourceFileName = platformDef.rootFile;

    if (!content) {
      content = rootFilesMap.get(FILE_PATTERNS.AGENTS_MD);
      sourceFileName = FILE_PATTERNS.AGENTS_MD;
    }

    if (!content) {
      // No content available for this platform
      continue;
    }

    // Install the content as the platform's root file
    try {
      const wasUpdated = await installSingleRootFile(cwd, platformDef.rootFile, formulaName, content);

      if (wasUpdated) {
        result.updated.push(platformDef.rootFile);
      } else {
        result.installed.push(platformDef.rootFile);
      }

      logger.debug(`Installed root file ${platformDef.rootFile} for ${formulaName}@${version} (from ${sourceFileName})`);
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


