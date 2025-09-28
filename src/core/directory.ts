import * as os from 'os';
import * as path from 'path';
import * as semver from 'semver';
import { G0Directories } from '../types/index.js';
import { PLATFORM_DIRS, FORMULA_DIRS } from '../constants/index.js';
import { ensureDir, exists, listDirectories } from '../utils/fs.js';
import { logger } from '../utils/logger.js';

/**
 * Cross-platform directory resolution following platform conventions
 */

/**
 * Get GroundZero directories using unified dotfile convention
 * Uses ~/.groundzero on all platforms for consistency (like AWS CLI with ~/.aws)
 * This approach prioritizes simplicity and cross-platform consistency
 */
export function getG0Directories(): G0Directories {
  const homeDir = os.homedir();
  const g0Dir = path.join(homeDir, PLATFORM_DIRS.GROUNDZERO);
  
  return {
    config: g0Dir,
    data: g0Dir,  // Same directory - follows dotfile convention
    cache: path.join(g0Dir, FORMULA_DIRS.CACHE),
    runtime: path.join(os.tmpdir(), 'groundzero')
  };
}

/**
 * Ensure all G0 directories exist
 */
export async function ensureG0Directories(): Promise<G0Directories> {
  const g0Dirs = getG0Directories();
  
  try {
    await Promise.all([
      ensureDir(g0Dirs.config),
      ensureDir(g0Dirs.data),
      ensureDir(g0Dirs.cache),
      ensureDir(g0Dirs.runtime)
    ]);
    
    logger.debug('G0 directories ensured', { directories: g0Dirs });
    return g0Dirs;
  } catch (error) {
    logger.error('Failed to create G0 directories', { error, directories: g0Dirs });
    throw error;
  }
}

/**
 * Get the registry directories
 */
export function getRegistryDirectories(): { formulas: string } {
  const g0Dirs = getG0Directories();
  const registryDir = path.join(g0Dirs.data, 'registry');
  
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
  const g0Dirs = getG0Directories();
  return path.join(g0Dirs.cache, cacheType);
}

/**
 * Get the temporary directory for a specific operation
 */
export function getTempDirectory(operation: string): string {
  const g0Dirs = getG0Directories();
  return path.join(g0Dirs.runtime, operation);
}

/**
 * Get the base path for a formula (contains all versions)
 */
export function getFormulaPath(formulaName: string): string {
  const dirs = getRegistryDirectories();
  return path.join(dirs.formulas, formulaName);
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

