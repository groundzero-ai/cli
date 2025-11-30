import { join } from 'path';

import { DIR_PATTERNS, FILE_PATTERNS, OPENPACKAGE_DIRS } from '../../constants/index.js';
import type { PackageYml } from '../../types/index.js';
import { exists, isDirectory } from '../../utils/fs.js';
import { parsePackageYml } from '../../utils/package-yml.js';
import { arePackageNamesEquivalent } from '../../utils/package-name.js';
import { getLocalPackageDir } from '../../utils/paths.js';
import { findDirectoriesContainingFile } from '../../utils/file-processing.js';
import { logger } from '../../utils/logger.js';

export type PackageLocation = 'root' | 'nested';

export interface DetectedPackageContext {
  packageDir: string;
  packageYmlPath: string;
  config: PackageYml;
  location: PackageLocation;
  isCwdPackage: boolean;
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
 * Detect package context for save/pack commands.
 *
 * Scope:
 *  - Root package at `cwd/.openpackage/package.yml`
 *  - Nested packages at `cwd/.openpackage/packages/<name>/package.yml`
 */
export async function detectPackageContext(
  cwd: string,
  packageName?: string
): Promise<DetectedPackageContext | null> {
  const rootPackageYmlPath = join(cwd, DIR_PATTERNS.OPENPACKAGE, FILE_PATTERNS.PACKAGE_YML);
  const hasRootPackage = await exists(rootPackageYmlPath);

  // No package name provided: target cwd as the package itself.
  if (!packageName) {
    if (!hasRootPackage) {
      return null;
    }

    try {
      const config = await parsePackageYml(rootPackageYmlPath);
      return {
        packageDir: cwd,
        packageYmlPath: rootPackageYmlPath,
        config,
        location: 'root',
        isCwdPackage: true
      };
    } catch (error) {
      logger.warn(`Failed to parse root package.yml: ${error}`);
      return null;
    }
  }

  // Package name provided: check root first.
  if (hasRootPackage) {
    try {
      const rootConfig = await parsePackageYml(rootPackageYmlPath);
      if (arePackageNamesEquivalent(rootConfig.name, packageName)) {
        return {
          packageDir: cwd,
          packageYmlPath: rootPackageYmlPath,
          config: rootConfig,
          location: 'root',
          isCwdPackage: true
        };
      }
    } catch (error) {
      logger.debug(`Failed to parse root package.yml: ${error}`);
    }
  }

  // Check nested packages directory for direct match.
  const nestedPackageDir = getLocalPackageDir(cwd, packageName);
  const nestedPackageYmlPath = join(nestedPackageDir, FILE_PATTERNS.PACKAGE_YML);

  if (await exists(nestedPackageYmlPath)) {
    try {
      const nestedConfig = await parsePackageYml(nestedPackageYmlPath);
      if (arePackageNamesEquivalent(nestedConfig.name, packageName)) {
        return {
          packageDir: nestedPackageDir,
          packageYmlPath: nestedPackageYmlPath,
          config: nestedConfig,
          location: 'nested',
          isCwdPackage: false
        };
      }
    } catch (error) {
      logger.debug(`Failed to parse nested package.yml at ${nestedPackageYmlPath}: ${error}`);
    }
  }

  // Scan nested packages for cases where directory name differs from package name.
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

        const packageRoot = dirPath;
        if (arePackageNamesEquivalent(parsedContent.name, packageName)) {
          return {
            packageDir: packageRoot,
            packageYmlPath: join(packageRoot, FILE_PATTERNS.PACKAGE_YML),
            config: parsedContent,
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

