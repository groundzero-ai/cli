/**
 * Root File Installer
 * Orchestrates installation of root files from registry to cwd
 */

import { join } from 'path';
import { exists, readTextFile, writeTextFile } from './fs.js';
import { mergePackageContentIntoRootFile } from './root-file-merger.js';
import { logger } from './logger.js';
import { FILE_PATTERNS } from '../constants/index.js';
import { getPlatformDefinition, type Platform } from '../core/platforms.js';

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
  packageName: string,
  rootFilesMap: Map<string, string>,
  detectedPlatforms: Platform[]
): Promise<RootFileInstallResult> {
  const result: RootFileInstallResult = { installed: [], skipped: [], updated: [] };
  if (rootFilesMap.size === 0) return result;

  // Always install/merge universal AGENTS.md regardless of platform detection
  const agentsContent = rootFilesMap.get(FILE_PATTERNS.AGENTS_MD);
  if (agentsContent && agentsContent.trim()) {
    try {
      const wasUpdated = await installSingleRootFile(
        cwd,
        FILE_PATTERNS.AGENTS_MD,
        packageName,
        agentsContent
      );
      if (wasUpdated) result.updated.push(FILE_PATTERNS.AGENTS_MD);
      else result.installed.push(FILE_PATTERNS.AGENTS_MD);
      logger.debug(`Installed universal root file ${FILE_PATTERNS.AGENTS_MD} for ${packageName}`);
    } catch (error) {
      logger.error(`Failed to install universal root file ${FILE_PATTERNS.AGENTS_MD}: ${error}`);
      result.skipped.push(FILE_PATTERNS.AGENTS_MD);
    }
  }

  for (const platform of detectedPlatforms) {
    const platformDef = getPlatformDefinition(platform);
    if (!platformDef.rootFile) continue;

    if (platformDef.rootFile === FILE_PATTERNS.AGENTS_MD) {
      continue; // Already handled by the universal install above
    }

    // Prefer platform-specific, otherwise use AGENTS.md if present
    let content = rootFilesMap.get(platformDef.rootFile);
    let sourceFileName = platformDef.rootFile;
    if (!content && rootFilesMap.has(FILE_PATTERNS.AGENTS_MD)) {
      content = rootFilesMap.get(FILE_PATTERNS.AGENTS_MD)!;
      sourceFileName = FILE_PATTERNS.AGENTS_MD;
    }
    if (!content) continue;

    try {
      const wasUpdated = await installSingleRootFile(cwd, platformDef.rootFile, packageName, content);
      if (wasUpdated) result.updated.push(platformDef.rootFile);
      else result.installed.push(platformDef.rootFile);
      logger.debug(`Installed root file ${platformDef.rootFile} for ${packageName} (from ${sourceFileName})`);
    } catch (error) {
      logger.error(`Failed to install root file ${platformDef.rootFile}: ${error}`);
      result.skipped.push(platformDef.rootFile);
    }
  }

  return result;
}


/**
 * Install or update a single root file at cwd root.
 * Preserves existing content and merges package section using markers.
 * 
 * @param cwd - Current working directory
 * @param rootFileName - Name of the root file (e.g., 'CLAUDE.md')
 * @param packageName - Name of the package
 * @param registryContent - Section body from the registry to merge (no markers)
 * @returns True if file was updated (existed before), false if newly created
 */
async function installSingleRootFile(
  cwd: string,
  rootFileName: string,
  packageName: string,
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

  // Registry stores only the section body (markers are added during merge)
  const sectionBody = registryContent.trim();

  // Merge package content into the file
  const mergedContent = mergePackageContentIntoRootFile(
    existingContent,
    packageName,
    sectionBody
  );

  // Write the merged content
  await writeTextFile(targetPath, mergedContent);

  return wasExisting;
}


