import { join } from 'path';
import { PLATFORM_DIRS, FILE_PATTERNS, FORMULA_DIRS } from '../constants/index.js';
import { exists } from './fs.js';
import { arePackageNamesEquivalent, SCOPED_FORMULA_REGEX } from './package-name.js';
import { parsePackageYml } from './package-yml.js';

/**
 * Path utility functions for consistent file and directory path handling
 * across the OpenPackage CLI application.
 */

/**
 * Get the path to the local package.yml file
 */
export function getLocalPackageYmlPath(cwd: string): string {
  return join(cwd, PLATFORM_DIRS.OPENPACKAGE, FILE_PATTERNS.FORMULA_YML);
}

/**
 * Check if a package name matches the root package in .openpackage/package.yml
 */
export async function isRootPackage(cwd: string, packageName: string): Promise<boolean> {
  const rootPackageYmlPath = getLocalPackageYmlPath(cwd);
  if (!(await exists(rootPackageYmlPath))) {
    return false;
  }
  
  try {
    const config = await parsePackageYml(rootPackageYmlPath);
    return arePackageNamesEquivalent(config.name, packageName);
  } catch (error) {
    return false;
  }
}

/**
 * Get the local OpenPackage directory path
 */
export function getLocalOpenPackageDir(cwd: string): string {
  return join(cwd, PLATFORM_DIRS.OPENPACKAGE);
}

/**
 * Get the local packages directory path
 */
export function getLocalPackagesDir(cwd: string): string {
  return join(cwd, PLATFORM_DIRS.OPENPACKAGE, FORMULA_DIRS.FORMULAS);
}

/**
 * Get the local package directory path for a specific package
 * Handles scoped packages with nested directory structure (@scope/name -> @scope/name/)
 */
export function getLocalPackageDir(cwd: string, packageName: string): string {
  const scopedMatch = packageName.match(SCOPED_FORMULA_REGEX);
  if (scopedMatch) {
    const [, scope, localName] = scopedMatch;
    return join(cwd, PLATFORM_DIRS.OPENPACKAGE, FORMULA_DIRS.FORMULAS, '@' + scope, localName);
  }
  return join(cwd, PLATFORM_DIRS.OPENPACKAGE, FORMULA_DIRS.FORMULAS, packageName);
}

/**
 * Get the AI directory path
 */
export function getAIDir(cwd: string): string {
  return join(cwd, PLATFORM_DIRS.AI);
}

