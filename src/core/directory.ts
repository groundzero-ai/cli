import * as os from 'os';
import * as path from 'path';
import * as semver from 'semver';
import { OpenPackageDirectories } from '../types/index.js';
import { PLATFORM_DIRS, FORMULA_DIRS } from '../constants/index.js';
import { ensureDir, exists, listDirectories } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { normalizeFormulaName } from '../utils/formula-name.js';

/**
 * Cross-platform directory resolution following platform conventions
 */

/**
 * Get OpenPackage directories using unified dotfile convention
 * Uses ~/.openpackage on all platforms for consistency (like AWS CLI with ~/.aws)
 * This approach prioritizes simplicity and cross-platform consistency
 */
export function getOpenPackageDirectories(): OpenPackageDirectories {
  const homeDir = os.homedir();
  const openPackageDir = path.join(homeDir, PLATFORM_DIRS.OPENPACKAGE);
  
  return {
    config: openPackageDir,
    data: openPackageDir,  // Same directory - follows dotfile convention
    cache: path.join(openPackageDir, FORMULA_DIRS.CACHE),
    runtime: path.join(os.tmpdir(), 'openpackage')
  };
}

/**
 * Ensure all OpenPackage directories exist
 */
export async function ensureOpenPackageDirectories(): Promise<OpenPackageDirectories> {
  const openPackageDirs = getOpenPackageDirectories();
  
  try {
    await Promise.all([
      ensureDir(openPackageDirs.config),
      ensureDir(openPackageDirs.data),
      ensureDir(openPackageDirs.cache),
      ensureDir(openPackageDirs.runtime)
    ]);
    
    logger.debug('OpenPackage directories ensured', { directories: openPackageDirs });
    return openPackageDirs;
  } catch (error) {
    logger.error('Failed to create OpenPackage directories', { error, directories: openPackageDirs });
    throw error;
  }
}

/**
 * Get the registry directories
 */
export function getRegistryDirectories(): { formulas: string } {
  const openPackageDirs = getOpenPackageDirectories();
  const registryDir = path.join(openPackageDirs.data, 'registry');
  
  return {
    formulas: path.join(registryDir, FORMULA_DIRS.FORMULAS)
  };
}

/**
 * Ensure registry directories exist
 */
export async function ensureRegistryDirectories(): Promise<{ formulas: string }> {
  const dirs = getRegistryDirectories();
  
  try {
    await ensureDir(dirs.formulas);
    
    logger.debug('Registry directories ensured', { directories: dirs });
    return dirs;
  } catch (error) {
    logger.error('Failed to create registry directories', { error, directories: dirs });
    throw error;
  }
}

/**
 * Get the cache directory for a specific type of cache
 */
export function getCacheDirectory(cacheType: string): string {
  const openPackageDirs = getOpenPackageDirectories();
  return path.join(openPackageDirs.cache, cacheType);
}

/**
 * Get the temporary directory for a specific operation
 */
export function getTempDirectory(operation: string): string {
  const openPackageDirs = getOpenPackageDirectories();
  return path.join(openPackageDirs.runtime, operation);
}

/**
 * Get the base path for a formula (contains all versions)
 * Formula names are normalized to lowercase for consistent registry paths.
 */
export function getFormulaPath(formulaName: string): string {
  const dirs = getRegistryDirectories();
  const normalizedName = normalizeFormulaName(formulaName);
  return path.join(dirs.formulas, normalizedName);
}

/**
 * Get the path for a specific version of a formula
 */
export function getFormulaVersionPath(formulaName: string, version: string): string {
  return path.join(getFormulaPath(formulaName), version);
}

/**
 * List all versions of a formula
 */
export async function listFormulaVersions(formulaName: string): Promise<string[]> {
  const formulaPath = getFormulaPath(formulaName);
  
  if (!(await exists(formulaPath))) {
    return [];
  }
  
  const versions = await listDirectories(formulaPath);
  return versions.sort((a, b) => semver.compare(b, a)); // Latest first
}

/**
 * Get the latest version of a formula
 */
export async function getLatestFormulaVersion(formulaName: string): Promise<string | null> {
  const versions = await listFormulaVersions(formulaName);
  return versions.length > 0 ? versions[0] : null;
}

/**
 * Check if a specific version exists
 */
export async function hasFormulaVersion(formulaName: string, version: string): Promise<boolean> {
  const versionPath = getFormulaVersionPath(formulaName, version);
  return await exists(versionPath);
}

/**
 * Find a formula by name, searching case-insensitively across registry directories.
 * Returns the normalized formula name if found, null otherwise.
 * If multiple formulas match the same normalized name, returns the first one found.
 */
export async function findFormulaByName(formulaName: string): Promise<string | null> {
  const normalizedTarget = normalizeFormulaName(formulaName);
  const dirs = getRegistryDirectories();

  if (!(await exists(dirs.formulas))) {
    return null;
  }

  const formulaDirs = await listDirectories(dirs.formulas);

  // First try exact normalized match
  if (formulaDirs.includes(normalizedTarget)) {
    return normalizedTarget;
  }

  // Then try case-insensitive match
  for (const dirName of formulaDirs) {
    if (normalizeFormulaName(dirName) === normalizedTarget) {
      return dirName; // Return the actual directory name as it exists on disk
    }
  }

  return null;
}

/**
 * List all formula base names in the local registry, including scoped formulas.
 * Returns names relative to the formulas root, e.g. 'name' or '@scope/name'.
 */
export async function listAllFormulas(): Promise<string[]> {
  const { formulas } = getRegistryDirectories();

  if (!(await exists(formulas))) {
    return [];
  }

  const result: string[] = [];
  const topLevelDirs = await listDirectories(formulas);

  for (const firstLevel of topLevelDirs) {
    const firstLevelPath = path.join(formulas, firstLevel);
    const firstLevelChildren = await listDirectories(firstLevelPath);

    // Unscoped formulas: name/<version>
    const hasSemverChildren = firstLevelChildren.some(child => semver.valid(child));
    if (hasSemverChildren) {
      result.push(firstLevel);
      continue;
    }

    // Scoped formulas: @scope/name/<version>
    for (const secondLevel of firstLevelChildren) {
      const secondLevelPath = path.join(firstLevelPath, secondLevel);
      const secondLevelChildren = await listDirectories(secondLevelPath);
      const hasSemverGrandchildren = secondLevelChildren.some(child => semver.valid(child));
      if (hasSemverGrandchildren) {
        result.push(`${firstLevel}/${secondLevel}`);
      }
    }
  }

  // Stable order
  result.sort((a, b) => a.localeCompare(b));
  return result;
}

