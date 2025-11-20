import { join } from 'path';
import { InstallOptions } from '../types/index.js';
import { ResolvedPackage } from '../core/dependency-resolver.js';
import { checkExistingPackageInMarkdownFiles } from '../core/openpackage.js';
import { parsePackageYml } from './package-yml.js';
import { exists } from './fs.js';
import { logger } from './logger.js';
import { getLocalPackageDir } from './paths.js';
import { FILE_PATTERNS } from '../constants/index.js';
import { getVersionInfoFromDependencyTree } from './install-helpers.js';
import { promptPackageOverwrite } from './prompts.js';

/**
 * Get currently installed version from .openpackage/packages/<package>/package.yml
 */
async function getInstalledPackageVersion(cwd: string, packageName: string): Promise<string | undefined> {
  try {
    const packageDir = getLocalPackageDir(cwd, packageName);
    const packageYmlPath = join(packageDir, FILE_PATTERNS.FORMULA_YML);
    if (await exists(packageYmlPath)) {
      const config = await parsePackageYml(packageYmlPath);
      return config.version;
    }
  } catch {
    // ignore parse errors; treat as unknown
  }
  return undefined;
}

/**
 * Check for existing package and handle conflict resolution
 */
export async function checkAndHandlePackageConflict(
  packageName: string,
  newVersion: string,
  resolvedPackages: ResolvedPackage[],
  options: InstallOptions
): Promise<{ shouldProceed: boolean; action: 'keep' | 'latest' | 'exact' | 'none'; version?: string; forceOverwrite?: boolean }> {
  const cwd = process.cwd();
  
  // Check for existing package in markdown files
  const existingCheck = await checkExistingPackageInMarkdownFiles(cwd, packageName);
  
  if (!existingCheck.found) {
    // No existing package found, proceed without warning or prompts
    logger.debug(`No existing package '${packageName}' found, proceeding with installation`);
    return { shouldProceed: true, action: 'none', forceOverwrite: false };
  }
  
  // Existing package found, get version info from dependency tree
  const versionInfo = await getVersionInfoFromDependencyTree(packageName, resolvedPackages);
  const existingVersion = existingCheck.version || await getInstalledPackageVersion(cwd, packageName);
  
  if (existingVersion) {
    logger.debug(`Found existing package '${packageName}' v${existingVersion} in ${existingCheck.location}`);
  } else {
    logger.debug(`Found existing package '${packageName}' in ${existingCheck.location}`);
  }
  
  if (options.dryRun) {
    // In dry run mode, proceed without forcing; per-file logic will report decisions
    return { shouldProceed: true, action: 'latest', forceOverwrite: false };
  }
  
  if (options.force) {
    // When --force is used, automatically overwrite
    logger.info(`Force flag set - automatically overwriting package '${packageName}' v${existingVersion}`);
    return { shouldProceed: true, action: 'latest', forceOverwrite: true };
  }
  
  // Proceed without prompting; per-file frontmatter-aware logic will handle overwrite decisions
  logger.info(`Proceeding without global prompt for '${packageName}'; per-file frontmatter will govern overwrites.`);
  return { shouldProceed: true, action: 'latest', forceOverwrite: false };
}

/**
 * Check for conflicts with all packages in the dependency tree
 */
export async function checkAndHandleAllPackageConflicts(
  resolvedPackages: ResolvedPackage[],
  options: InstallOptions
): Promise<{ shouldProceed: boolean; skippedPackages: string[]; forceOverwritePackages: Set<string> }> {
  const cwd = process.cwd();
  const skippedPackages: string[] = [];
  const forceOverwritePackages = new Set<string>();
  
  // Check each package in the dependency tree for conflicts
  for (const resolved of resolvedPackages) {
    const existingCheck = await checkExistingPackageInMarkdownFiles(cwd, resolved.name);
    
    if (existingCheck.found) {
      const versionInfo = await getVersionInfoFromDependencyTree(resolved.name, resolvedPackages);
      const existingVersion = existingCheck.version || await getInstalledPackageVersion(cwd, resolved.name);
      
      if (existingVersion) {
        logger.debug(`Found existing package '${resolved.name}' v${existingVersion} in ${existingCheck.location}`);
      } else {
        logger.debug(`Found existing package '${resolved.name}' in ${existingCheck.location}`);
      }
      
      if (options.dryRun) {
        // In dry run mode, proceed; per-file logic will report decisions
        continue;
      }
      
      if (options.force) {
        // When --force is used, automatically overwrite all conflicts
        logger.info(`Force flag set - automatically overwriting package '${resolved.name}' v${existingVersion}`);
        forceOverwritePackages.add(resolved.name);
        continue;
      }
      
      // Prompt per package overwrite confirmation when existing detected
      const confirmed = await promptPackageOverwrite(resolved.name, existingVersion);
      if (confirmed) {
        forceOverwritePackages.add(resolved.name);
      } else {
        skippedPackages.push(resolved.name);
      }
      continue;
    }
  }
  
  return { shouldProceed: true, skippedPackages, forceOverwritePackages };
}
