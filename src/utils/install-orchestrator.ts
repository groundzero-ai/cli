import { join, dirname } from 'path';
import { InstallOptions } from '../types/index.js';
import { ResolvedFormula } from '../core/dependency-resolver.js';
import { CONFLICT_RESOLUTION, FILE_PATTERNS } from '../constants/index.js';
import { logger } from './logger.js';
import { formulaManager } from '../core/formula.js';
import { exists, ensureDir, writeTextFile } from './fs.js';

/**
 * Install formula files to ai directory
 * @param formulaName - Name of the formula to install
 * @param targetDir - Target directory for installation
 * @param options - Installation options including force and dry-run flags
 * @param version - Specific version to install (optional)
 * @param forceOverwrite - Force overwrite existing files
 * @returns Object containing installation results including file counts and status flags
 */
export async function installFormula(
  formulaName: string,
  targetDir: string,
  options: InstallOptions,
  version?: string,
  forceOverwrite?: boolean
): Promise<{ installedCount: number; files: string[]; overwritten: boolean; skipped: boolean }> {
  logger.debug(`Installing formula files for ${formulaName} to ${targetDir}`, { version, forceOverwrite });
  
  try {
    // Get formula from registry
    const formula = await formulaManager.loadFormula(formulaName, version);
    
    // Filter files to install (exclude formula.yml and root markdown files)
    const filesToInstall = formula.files.filter(file => 
      file.path !== FILE_PATTERNS.FORMULA_YML && !file.path.endsWith(FILE_PATTERNS.MD_FILES)
    );
    
    if (filesToInstall.length === 0) {
      logger.debug(`No files to install for ${formulaName}@${version || 'latest'}`);
      return { installedCount: 0, files: [], overwritten: false, skipped: true };
    }
    
    // Check for existing files in parallel
    const existenceChecks = await Promise.all(
      filesToInstall.map(async (file) => {
        const targetPath = join(targetDir, file.path);
        const fileExists = await exists(targetPath);
        return { file, targetPath, exists: fileExists };
      })
    );
    
    const conflicts = existenceChecks.filter(item => item.exists);
    const hasOverwritten = conflicts.length > 0 && (options.force === true || forceOverwrite === true);
    
    // Handle conflicts - skip if files exist and no force flag
    if (conflicts.length > 0 && options.force !== true && forceOverwrite !== true) {
      logger.debug(`Skipping ${formulaName} - files would be overwritten: ${conflicts.map(c => c.targetPath).join(', ')}`);
      return { installedCount: 0, files: [], overwritten: false, skipped: true };
    }
    
    // Pre-create all necessary directories
    const directories = new Set<string>();
    for (const { targetPath } of existenceChecks) {
      directories.add(dirname(targetPath));
    }
    
    // Create all directories in parallel
    await Promise.all(Array.from(directories).map(dir => ensureDir(dir)));
    
    // Install files in parallel
    const installedFiles: string[] = [];
    const installPromises = existenceChecks.map(async ({ file, targetPath }) => {
      await writeTextFile(targetPath, file.content);
      installedFiles.push(targetPath);
      logger.debug(`Installed file: ${targetPath}`);
    });
    
    await Promise.all(installPromises);
    
    logger.info(`Successfully installed ${installedFiles.length} files for ${formulaName}@${version || 'latest'}`);
    
    return {
      installedCount: filesToInstall.length,
      files: installedFiles,
      overwritten: hasOverwritten,
      skipped: false
    };
    
  } catch (error) {
    logger.error(`Failed to install formula ${formulaName}: ${error}`);
    return {
      installedCount: 0,
      files: [],
      overwritten: false,
      skipped: true
    };
  }
}

/**
 * Process resolved formulas for installation
 */
export async function processResolvedFormulas(
  resolvedFormulas: ResolvedFormula[],
  targetDir: string,
  options: InstallOptions,
  forceOverwriteFormulas?: Set<string>
): Promise<{ installedCount: number; skippedCount: number; groundzeroResults: Array<{ name: string; filesInstalled: number; files: string[]; overwritten: boolean }> }> {
  let installedCount = 0;
  let skippedCount = 0;
  const groundzeroResults: Array<{ name: string; filesInstalled: number; files: string[]; overwritten: boolean }> = [];
  
  for (const resolved of resolvedFormulas) {
    if (resolved.conflictResolution === CONFLICT_RESOLUTION.SKIPPED) {
      skippedCount++;
      console.log(`⏭️  Skipped ${resolved.name}@${resolved.version} (user declined overwrite)`);
      continue;
    }
    
    if (resolved.conflictResolution === CONFLICT_RESOLUTION.KEPT) {
      skippedCount++;
      console.log(`⏭️  Skipped ${resolved.name}@${resolved.version} (same or newer version already installed)`);
      continue;
    }
    
    const shouldForceOverwrite = forceOverwriteFormulas?.has(resolved.name) || false;
    const groundzeroResult = await installFormula(resolved.name, targetDir, options, resolved.version, shouldForceOverwrite);
    
    if (groundzeroResult.skipped) {
      skippedCount++;
      console.log(`⏭️  Skipped ${resolved.name}@${resolved.version} (same or newer version already installed)`);
      continue;
    }
    
    installedCount++;
    groundzeroResults.push({
      name: resolved.name,
      filesInstalled: groundzeroResult.installedCount,
      files: groundzeroResult.files,
      overwritten: groundzeroResult.overwritten
    });
    
    if (resolved.conflictResolution === CONFLICT_RESOLUTION.OVERWRITTEN || groundzeroResult.overwritten) {
      console.log(`🔄 Overwritten ${resolved.name}@${resolved.version} in ai`);
    }
  }
  
  return { installedCount, skippedCount, groundzeroResults };
}
