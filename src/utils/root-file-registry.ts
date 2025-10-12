/**
 * Root File Registry Reader
 * Utility for reading root files from the local formula registry
 */

import { join } from 'path';
import { getFormulaVersionPath } from '../core/directory.js';
import { exists, readTextFile } from './fs.js';
import { FILE_PATTERNS, type Platform } from '../constants/index.js';
import { logger } from './logger.js';
import { getAllPlatforms, getPlatformDefinition } from '../core/platforms.js';

/**
 * Get all root files from a formula version in the local registry.
 * Returns a map of filename → content for all root files found.
 * 
 * @param formulaName - Name of the formula
 * @param version - Version of the formula
 * @returns Map of root filename to file content
 */
export async function getRootFilesFromRegistry(
  formulaName: string,
  version: string
): Promise<Map<string, string>> {
  const rootFiles = new Map<string, string>();
  const versionPath = getFormulaVersionPath(formulaName, version);

  if (!(await exists(versionPath))) {
    logger.debug(`Formula version path does not exist: ${versionPath}`);
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
          logger.debug(`Found root file in registry: ${rootFileName} for ${formulaName}@${version}`);
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
  // Prefer dynamic mapping via platform definitions
  for (const platform of getAllPlatforms()) {
    const def = getPlatformDefinition(platform);
    if (def.rootFile === filename) {
      return platform;
    }
  }
  // Fallback to universal for AGENTS.md or unknown
  return filename === FILE_PATTERNS.AGENTS_MD ? 'universal' : 'universal';
}


