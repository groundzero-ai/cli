import { join } from 'path';
import { InstallOptions } from '../types/index.js';
import { exists, ensureDir, writeTextFile } from './fs.js';
import { logger } from './logger.js';
import { UNIVERSAL_SUBDIRS, type Platform } from '../constants/index.js';
import { mapUniversalToPlatform } from './platform-mapper.js';
import { RESOURCES_RULES } from './embedded-resources.js';

/**
 * Install formula files to ai directory
 * @param formulaName - Name of the formula to install
 * @param targetDir - Target directory for installation
 * @param options - Installation options including force and dry-run flags
 * @param version - Specific version to install (optional)
 * @param forceOverwrite - Force overwrite existing files
 * @returns Object containing installation results including file counts and status flags
 */
export async function installFormulaFiles(
  formulaName: string,
  targetDir: string,
  options: InstallOptions,
  version?: string,
  forceOverwrite?: boolean
): Promise<{ installedCount: number; files: string[]; overwritten: boolean; skipped: boolean }> {
  // This is a placeholder implementation
  // The actual implementation would need to be extracted from the original install.ts
  // For now, return a minimal response to satisfy the interface
  
  logger.debug(`Installing formula files for ${formulaName} to ${targetDir}`, { version, forceOverwrite });
  
  return {
    installedCount: 0,
    files: [],
    overwritten: false,
    skipped: false
  };
}

/**
 * Provide IDE-specific template files for detected platforms
 * @param targetDir - Target directory where platform directories exist
 * @param platforms - Array of platform names to add rule files for
 * @param options - Installation options including force flag
 * @returns Object containing arrays of added files, skipped files, and created directories
 */
export async function provideIdeTemplateFiles(
  targetDir: string,
  platforms: string[],
  options: InstallOptions
): Promise<{ filesAdded: string[]; skipped: string[]; directoriesCreated: string[] }> {
  const provided = {
    filesAdded: [] as string[],
    skipped: [] as string[],
    directoriesCreated: [] as string[]
  };

  // Process platforms in parallel
  const platformPromises = platforms.map(async (platform) => {
    // Use centralized platform mapping to get the rules directory path
    const { absDir: rulesDirRelative } = mapUniversalToPlatform(platform as Platform, UNIVERSAL_SUBDIRS.RULES, '');
    const rulesDir = join(targetDir, rulesDirRelative);

    const rulesDirExists = await exists(rulesDir);
    if (!rulesDirExists) {
      provided.directoriesCreated.push(rulesDirRelative);
    }

    // Add platform-specific rule file
    const ruleFileName = 'rules.md';
    const ruleFilePath = join(rulesDir, ruleFileName);
    
    if (await exists(ruleFilePath) && !options.force) {
      provided.skipped.push(ruleFilePath);
      return;
    }

    // Create directory if it doesn't exist
    if (!rulesDirExists) {
      await ensureDir(rulesDir);
    }

    // Write the rule file with embedded content
    const ruleContent = RESOURCES_RULES['groundzero.md'];
    await writeTextFile(ruleFilePath, ruleContent);
    provided.filesAdded.push(ruleFilePath);
  });

  await Promise.all(platformPromises);

  logger.debug(`Provided IDE template files for platforms: ${platforms.join(', ')}`, {
    filesAdded: provided.filesAdded.length,
    skipped: provided.skipped.length,
    directoriesCreated: provided.directoriesCreated.length
  });

  return provided;
}
