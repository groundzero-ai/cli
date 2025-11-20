/**
 * Root File Registry Reader
 * Utility for reading root files from the local package registry
 */

import { join } from 'path';
import { getPackageVersionPath } from '../core/directory.js';
import { exists, readTextFile } from './fs.js';
import { FILE_PATTERNS, type Platform } from '../constants/index.js';
import { logger } from './logger.js';
import { getAllPlatforms, getPlatformDefinition } from '../core/platforms.js';

/**
 * Get all root files from a package version in the local registry.
 * Returns a map of filename → content for all root files found.
 * 
 * @param packageName - Name of the package
 * @param version - Version of the package
 * @returns Map of root filename to file content
 */
export async function getRootFilesFromRegistry(
  packageName: string,
  version: string
): Promise<Map<string, string>> {
  const rootFiles = new Map<string, string>();
  const versionPath = getPackageVersionPath(packageName, version);

  if (!(await exists(versionPath))) {
    logger.debug(`Package version path does not exist: ${versionPath}`);
    return rootFiles;
  }

  // Build dynamic list of possible root files from platform definitions
  const possibleRootFiles = (() => {
    const set = new Set<string>();
    for (const platform of getAllPlatforms()) {
      const def = getPlatformDefinition(platform);
      if (def.rootFile) set.add(def.rootFile);
    }
    // Ensure universal AGENTS.md is included (for platforms that map to it)
    set.add(FILE_PATTERNS.AGENTS_MD);
    return Array.from(set.values());
  })();

  // Check each possible root file
  for (const rootFileName of possibleRootFiles) {
    const rootFilePath = join(versionPath, rootFileName);
    
    if (await exists(rootFilePath)) {
      try {
        const content = await readTextFile(rootFilePath);
        if (content.trim()) {
          rootFiles.set(rootFileName, content);
          logger.debug(`Found root file in registry: ${rootFileName} for ${packageName}@${version}`);
        }
      } catch (error) {
        logger.warn(`Failed to read root file ${rootFileName} from registry: ${error}`);
      }
    }
  }

  return rootFiles;
}

/**
 * Map a root filename to its corresponding platform.
 * Returns 'universal' for AGENTS.md since it maps to multiple platforms.
 * 
 * @param filename - Root filename (e.g., 'CLAUDE.md', 'AGENTS.md')
 * @returns Platform identifier or 'universal' for AGENTS.md
 */
export function getPlatformForRootFile(filename: string): Platform | 'universal' {
  // AGENTS.md is universal since it maps to multiple platforms
  if (filename === FILE_PATTERNS.AGENTS_MD) {
    return 'universal';
  }

  // Check platform-specific root files
  for (const platform of getAllPlatforms()) {
    const def = getPlatformDefinition(platform);
    if (def.rootFile === filename) {
      return platform;
    }
  }

  // Unknown root file
  return 'universal';
}


