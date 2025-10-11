import { InstallOptions } from '../types/index.js';
import { ResolvedFormula } from '../core/dependency-resolver.js';
import { CONFLICT_RESOLUTION } from '../constants/index.js';
import { logger } from './logger.js';

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
