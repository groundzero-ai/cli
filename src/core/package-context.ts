/**
 * Unified Package Context
 * 
 * Provides consistent package location resolution for all pipelines.
 * Root packages store files under .openpackage/<subdir>/
 * Nested packages store files under .openpackage/packages/<name>/<subdir>/
 */

import { join } from 'path';

import { DIR_PATTERNS, FILE_PATTERNS, OPENPACKAGE_DIRS } from '../constants/index.js';
import type { PackageYml } from '../types/index.js';
import { exists, isDirectory } from '../utils/fs.js';
import { parsePackageYml } from '../utils/package-yml.js';
import { arePackageNamesEquivalent, normalizePackageName } from '../utils/package-name.js';
import { findDirectoriesContainingFile } from '../utils/file-processing.js';
import { logger } from '../utils/logger.js';

/**
 * Package location type
 */
export type PackageLocation = 'root' | 'nested';

/**
 * Unified package context used by all pipelines.
 * 
 * Key distinction:
 * - packageYmlPath: where package.yml lives
 * - packageFilesDir: where package content files live (rules/, commands/, etc.)
 * 
 * For root packages:
 *   packageYmlPath = .openpackage/package.yml
 *   packageFilesDir = .openpackage/
 * 
 * For nested packages:
 *   packageYmlPath = .openpackage/packages/<name>/package.yml
 *   packageFilesDir = .openpackage/packages/<name>/
 */
export interface PackageContext {
  /** Normalized package name */
  name: string;
  
  /** Package version from package.yml */
  version: string;
  
  /** Full config from package.yml */
  config: PackageYml;
  
  /** Absolute path to package.yml */
  packageYmlPath: string;
  
  /** 
   * Absolute path to directory containing package files (rules/, commands/, etc.)
   * - Root: <cwd>/.openpackage/
   * - Nested: <cwd>/.openpackage/packages/<name>/
   */
  packageFilesDir: string;
  
  /** Package location type */
  location: PackageLocation;
  
  /** Whether this is the cwd's own package (root package without explicit name) */
  isCwdPackage: boolean;
  
  /** Whether this package was newly created (for init/add flows) */
  isNew?: boolean;
}

/**
 * Legacy DetectedPackageContext for backward compatibility during migration.
 * @deprecated Use PackageContext instead
 */
export interface DetectedPackageContext {
  packageDir: string;
  packageYmlPath: string;
  config: PackageYml;
  location: PackageLocation;
  isCwdPackage: boolean;
}

/**
 * Get the package files directory based on location.
 */
export function getPackageFilesDir(cwd: string, location: PackageLocation, packageName?: string): string {
  if (location === 'root') {
    return join(cwd, DIR_PATTERNS.OPENPACKAGE);
  }
  
  if (!packageName) {
    throw new Error('Package name required for nested packages');
  }
  
  return join(cwd, DIR_PATTERNS.OPENPACKAGE, OPENPACKAGE_DIRS.PACKAGES, normalizePackageName(packageName));
}

/**
 * Get the package.yml path based on location.
 */
export function getPackageYmlPath(cwd: string, location: PackageLocation, packageName?: string): string {
  if (location === 'root') {
    return join(cwd, DIR_PATTERNS.OPENPACKAGE, FILE_PATTERNS.PACKAGE_YML);
  }
  
  if (!packageName) {
    throw new Error('Package name required for nested packages');
  }
  
  return join(
    cwd,
    DIR_PATTERNS.OPENPACKAGE,
    OPENPACKAGE_DIRS.PACKAGES,
    normalizePackageName(packageName),
    FILE_PATTERNS.PACKAGE_YML
  );
}

/**
 * Core rule: any directory that contains `.openpackage/package.yml` is a valid package.
 */
export async function isValidPackageDirectory(dir: string): Promise<boolean> {
  const packageYmlPath = join(dir, DIR_PATTERNS.OPENPACKAGE, FILE_PATTERNS.PACKAGE_YML);
  return exists(packageYmlPath);
}

/**
 * Load package config from a directory that satisfies the core rule.
 */
export async function loadPackageConfig(dir: string): Promise<PackageYml | null> {
  const packageYmlPath = join(dir, DIR_PATTERNS.OPENPACKAGE, FILE_PATTERNS.PACKAGE_YML);
  if (!(await exists(packageYmlPath))) {
    return null;
  }

  try {
    return await parsePackageYml(packageYmlPath);
  } catch (error) {
    logger.debug(`Failed to parse package.yml at ${packageYmlPath}: ${error}`);
    return null;
  }
}

/**
 * Detect package context for any pipeline operation.
 * 
 * Resolution order:
 * 1. No packageName provided → target cwd as root package
 * 2. packageName matches root package name → root package
 * 3. packageName found in nested packages → nested package
 * 4. packageName not found → null (caller decides: error or create)
 */
export async function detectPackageContext(
  cwd: string,
  packageName?: string
): Promise<PackageContext | null> {
  const rootPackageYmlPath = getPackageYmlPath(cwd, 'root');
  const hasRootPackage = await exists(rootPackageYmlPath);

  // No package name provided: target cwd as the package itself
  if (!packageName) {
    if (!hasRootPackage) {
      return null;
    }

    try {
      const config = await parsePackageYml(rootPackageYmlPath);
      return {
        name: normalizePackageName(config.name),
        version: config.version,
        config,
        packageYmlPath: rootPackageYmlPath,
        packageFilesDir: getPackageFilesDir(cwd, 'root'),
        location: 'root',
        isCwdPackage: true
      };
    } catch (error) {
      logger.warn(`Failed to parse root package.yml: ${error}`);
      return null;
    }
  }

  const normalizedName = normalizePackageName(packageName);

  // Package name provided: check if it matches root package
  if (hasRootPackage) {
    try {
      const rootConfig = await parsePackageYml(rootPackageYmlPath);
      if (arePackageNamesEquivalent(rootConfig.name, packageName)) {
        return {
          name: normalizedName,
          version: rootConfig.version,
          config: rootConfig,
          packageYmlPath: rootPackageYmlPath,
          packageFilesDir: getPackageFilesDir(cwd, 'root'),
          location: 'root',
          isCwdPackage: true
        };
      }
    } catch (error) {
      logger.debug(`Failed to parse root package.yml: ${error}`);
    }
  }

  // Check nested packages directory
  const nestedPackageYmlPath = getPackageYmlPath(cwd, 'nested', packageName);
  const nestedPackageFilesDir = getPackageFilesDir(cwd, 'nested', packageName);

  if (await exists(nestedPackageYmlPath)) {
    try {
      const nestedConfig = await parsePackageYml(nestedPackageYmlPath);
      if (arePackageNamesEquivalent(nestedConfig.name, packageName)) {
        return {
          name: normalizedName,
          version: nestedConfig.version,
          config: nestedConfig,
          packageYmlPath: nestedPackageYmlPath,
          packageFilesDir: nestedPackageFilesDir,
          location: 'nested',
          isCwdPackage: false
        };
      }
    } catch (error) {
      logger.debug(`Failed to parse nested package.yml at ${nestedPackageYmlPath}: ${error}`);
    }
  }

  // Scan nested packages for cases where directory name differs from package name
  const packagesDir = join(cwd, DIR_PATTERNS.OPENPACKAGE, OPENPACKAGE_DIRS.PACKAGES);
  if (await exists(packagesDir) && (await isDirectory(packagesDir))) {
    try {
      const packageDirs = await findDirectoriesContainingFile(
        packagesDir,
        FILE_PATTERNS.PACKAGE_YML,
        async filePath => {
          try {
            return await parsePackageYml(filePath);
          } catch {
            return null;
          }
        }
      );

      for (const { dirPath, parsedContent } of packageDirs) {
        if (!parsedContent) continue;

        if (arePackageNamesEquivalent(parsedContent.name, packageName)) {
          return {
            name: normalizedName,
            version: parsedContent.version,
            config: parsedContent,
            packageYmlPath: join(dirPath, FILE_PATTERNS.PACKAGE_YML),
            packageFilesDir: dirPath,
            location: 'nested',
            isCwdPackage: false
          };
        }
      }
    } catch (error) {
      logger.debug(`Failed to scan packages directory: ${error}`);
    }
  }

  return null;
}

/**
 * Create a new package context for initialization.
 * Does not write any files - just builds the context.
 */
export function createPackageContext(
  cwd: string,
  config: PackageYml,
  location: PackageLocation
): PackageContext {
  const normalizedName = normalizePackageName(config.name);
  
  return {
    name: normalizedName,
    version: config.version,
    config,
    packageYmlPath: getPackageYmlPath(cwd, location, location === 'nested' ? normalizedName : undefined),
    packageFilesDir: getPackageFilesDir(cwd, location, location === 'nested' ? normalizedName : undefined),
    location,
    isCwdPackage: location === 'root',
    isNew: true
  };
}

/**
 * Check if a package context represents a root package.
 */
export function isRootPackage(ctx: PackageContext): boolean {
  return ctx.location === 'root';
}

/**
 * Convert PackageContext to legacy DetectedPackageContext format.
 * @deprecated Use PackageContext directly
 */
export function toDetectedPackageContext(ctx: PackageContext): DetectedPackageContext {
  return {
    packageDir: ctx.packageFilesDir,
    packageYmlPath: ctx.packageYmlPath,
    config: ctx.config,
    location: ctx.location,
    isCwdPackage: ctx.isCwdPackage
  };
}

/**
 * Error message for when no package is detected.
 */
export function getNoPackageDetectedMessage(packageName?: string): string {
  if (packageName) {
    return (
      `Package '${packageName}' not found.\n\n` +
      `Checked locations:\n` +
      `  • Root package: .openpackage/package.yml\n` +
      `  • Nested packages: .openpackage/packages/${packageName}/\n\n` +
      `💡 To create a new package, run: opkg save ${packageName}`
    );
  }

  return (
    `No package detected at current directory.\n\n` +
    `A valid package requires .openpackage/package.yml to exist.\n\n` +
    `💡 To initialize a package:\n` +
    `   • Run 'opkg init' to create a new package\n` +
    `   • Or specify a package name: 'opkg save <package-name>'`
  );
}

