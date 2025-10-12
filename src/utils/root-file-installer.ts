/**
 * Root File Installer
 * Orchestrates installation of root files from registry to cwd
 */

import { join } from 'path';
import { exists, readTextFile, writeTextFile } from './fs.js';
import { getRootFilesFromRegistry, getPlatformForRootFile } from './root-file-registry.js';
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

  // Process each root file from registry
  for (const [rootFileName, registryContent] of rootFilesMap.entries()) {
    const targetPlatform = getPlatformForRootFile(rootFileName);

    // Check if this root file should be installed based on detected platforms
    const shouldInstall = shouldInstallRootFile(rootFileName, targetPlatform, detectedPlatforms);

    if (!shouldInstall) {
      result.skipped.push(rootFileName);
      logger.debug(`Skipped ${rootFileName} - platform not detected`);
      continue;
    }

    // Install or update the root file
    try {
      const wasUpdated = await installSingleRootFile(cwd, rootFileName, formulaName, registryContent);
      
      if (wasUpdated) {
        result.updated.push(rootFileName);
      } else {
        result.installed.push(rootFileName);
      }
      
      logger.debug(`Installed root file ${rootFileName} for ${formulaName}@${version}`);
    } catch (error) {
      logger.error(`Failed to install root file ${rootFileName}: ${error}`);
      result.skipped.push(rootFileName);
    }
  }

  return result;
}

/**
 * Determine if a root file should be installed based on platform detection.
 * 
 * @param rootFileName - Name of the root file (e.g., 'CLAUDE.md')
 * @param targetPlatform - Platform associated with the root file
 * @param detectedPlatforms - List of detected platforms
 * @returns True if the root file should be installed
 */
function shouldInstallRootFile(
  rootFileName: string,
  targetPlatform: Platform | 'universal',
  detectedPlatforms: Platform[]
): boolean {
  // AGENTS.md is universal - install if any compatible platform is detected
  if (targetPlatform === 'universal' && rootFileName === FILE_PATTERNS.AGENTS_MD) {
    // Compute AGENTS.md-compatible platforms dynamically from platform definitions
    const agentsCompatible = new Set<Platform>();
    for (const platform of getAllPlatforms()) {
      const def = getPlatformDefinition(platform);
      if (def.rootFile === FILE_PATTERNS.AGENTS_MD) {
        agentsCompatible.add(platform);
      }
    }
    return detectedPlatforms.some(p => agentsCompatible.has(p));
  }

  // Platform-specific root file - install only if that platform is detected
  if (targetPlatform !== 'universal') {
    return detectedPlatforms.includes(targetPlatform);
  }

  return false;
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


