import { basename, join, relative } from 'path';
import { PackageYml, PackageDependency } from '../types/index.js';
import { parsePackageYml, writePackageYml } from './package-yml.js';
import { exists, ensureDir, writeTextFile, walkFiles, remove } from './fs.js';
import { logger } from './logger.js';
import { getLocalOpenPackageDir, getLocalPackageYmlPath, getLocalPackagesDir, getLocalPackageDir } from './paths.js';
import { DEPENDENCY_ARRAYS } from '../constants/index.js';
import { createCaretRange } from './version-ranges.js';
import { extractBaseVersion } from './version-generator.js';
import { normalizePackageName, arePackageNamesEquivalent } from './package-name.js';
import { packageManager } from '../core/package.js';
import { PACKAGE_INDEX_FILENAME } from './package-index-yml.js';

/**
 * Ensure local OpenPackage directory structure exists
 * Shared utility for both install and save commands
 */
export async function ensureLocalOpenPackageStructure(cwd: string): Promise<void> {
  const openpackageDir = getLocalOpenPackageDir(cwd);
  const packagesDir = getLocalPackagesDir(cwd);
  
  await Promise.all([
    ensureDir(openpackageDir),
    ensureDir(packagesDir)
  ]);
}

/**
 * Create a basic package.yml file if it doesn't exist
 * Shared utility for both install and save commands
 * @param force - If true, overwrite existing package.yml
 * @returns the package.yml if it was created, null if it already existed and force=false
 */
export async function createBasicPackageYml(cwd: string, force: boolean = false): Promise<PackageYml | null> {
  await ensureLocalOpenPackageStructure(cwd);

  const packageYmlPath = getLocalPackageYmlPath(cwd);
  const projectName = basename(cwd);
  const basicPackageYml: PackageYml = {
    name: projectName,
    version: '0.1.0',
    packages: [],
    'dev-packages': []
  };

  if (await exists(packageYmlPath)) {
    if (!force) {
      return null; // package.yml already exists, no need to create
    }
    await writePackageYml(packageYmlPath, basicPackageYml);
    logger.info(`Overwrote basic package.yml with name: ${projectName}`);
    console.log(`📋 Overwrote basic package.yml in .openpackage/ with name: ${projectName}`);
    return basicPackageYml;
  }

  await writePackageYml(packageYmlPath, basicPackageYml);
  logger.info(`Initialized workspace package.yml`);
  console.log(`📋 Initialized workspace package.yml in .openpackage/`);
  return basicPackageYml;
}

/**
 * Add a package dependency to package.yml with smart placement logic
 * Shared utility for both install and save commands
 */
export async function addPackageToYml(
  cwd: string,
  packageName: string,
  packageVersion: string,
  isDev: boolean = false,
  originalVersion?: string, // The original version/range that was requested
  silent: boolean = false
): Promise<void> {
  const packageYmlPath = getLocalPackageYmlPath(cwd);
  
  if (!(await exists(packageYmlPath))) {
    return; // If no package.yml exists, ignore this step
  }
  
  const config = await parsePackageYml(packageYmlPath);
  
  // Determine the version to write to package.yml
  let versionToWrite: string;
  
  if (originalVersion) {
    // If we have the original version/range, use it as-is
    versionToWrite = originalVersion;
  } else {
    // For save command, strip prerelease versioning and create caret range
    const baseVersion = extractBaseVersion(packageVersion);
    versionToWrite = createCaretRange(baseVersion);
  }
  
  const dependency: PackageDependency = {
    name: normalizePackageName(packageName),
    version: versionToWrite
  };
  
  // Find current location and determine target location
  const currentLocation = await findPackageLocation(cwd, packageName);
  
  let targetArray: 'packages' | 'dev-packages';
  if (currentLocation === DEPENDENCY_ARRAYS.DEV_PACKAGES && !isDev) {
    targetArray = DEPENDENCY_ARRAYS.DEV_PACKAGES;
    logger.info(`Keeping package in dev-packages: ${packageName}@${packageVersion}`);
  } else if (currentLocation === DEPENDENCY_ARRAYS.PACKAGES && isDev) {
    targetArray = DEPENDENCY_ARRAYS.DEV_PACKAGES;
    logger.info(`Moving package from packages to dev-packages: ${packageName}@${packageVersion}`);
  } else {
    targetArray = isDev ? DEPENDENCY_ARRAYS.DEV_PACKAGES : DEPENDENCY_ARRAYS.PACKAGES;
  }
  
  // Initialize arrays if they don't exist
  if (!config.packages) config.packages = [];
  if (!config[DEPENDENCY_ARRAYS.DEV_PACKAGES]) config[DEPENDENCY_ARRAYS.DEV_PACKAGES] = [];
  
  // Remove from current location if moving between arrays
  if (currentLocation && currentLocation !== targetArray) {
    const currentArray = config[currentLocation]!;
    const currentIndex = currentArray.findIndex(dep => arePackageNamesEquivalent(dep.name, packageName));
    if (currentIndex >= 0) {
      currentArray.splice(currentIndex, 1);
    }
  }
  
  // Update or add dependency
  const targetArrayRef = config[targetArray]!;
  const existingIndex = targetArrayRef.findIndex(dep => arePackageNamesEquivalent(dep.name, packageName));
  
  if (existingIndex >= 0) {
    targetArrayRef[existingIndex] = dependency;
    if (!silent) {
      logger.info(`Updated existing package dependency: ${packageName}@${packageVersion}`);
      console.log(`✓ Updated ${packageName}@${packageVersion} in main package.yml`);
    }
  } else {
    targetArrayRef.push(dependency);
    if (!silent) {
      logger.info(`Added new package dependency: ${packageName}@${packageVersion}`);
      console.log(`✓ Added ${packageName}@${packageVersion} to main package.yml`);
    }
  }
  
  await writePackageYml(packageYmlPath, config);
}

/**
 * Copy the full package directory from the local registry into the project structure
 * Removes all existing files except package.index.yml before writing new files
 */
export async function writeLocalPackageFromRegistry(
  cwd: string,
  packageName: string,
  version: string
): Promise<void> {
  const pkg = await packageManager.loadPackage(packageName, version);
  const localPackageDir = getLocalPackageDir(cwd, packageName);

  await ensureDir(localPackageDir);

  // Build set of files that should exist after installation
  const filesToKeep = new Set<string>(
    pkg.files.map(file => file.path)
  );
  // Always preserve package.index.yml
  filesToKeep.add(PACKAGE_INDEX_FILENAME);

  // List all existing files in the directory
  const existingFiles: string[] = [];
  if (await exists(localPackageDir)) {
    for await (const filePath of walkFiles(localPackageDir)) {
      const relPath = relative(localPackageDir, filePath);
      existingFiles.push(relPath);
    }
  }

  // Remove files that are no longer in the package (except package.index.yml)
  const filesToRemove = existingFiles.filter(file => !filesToKeep.has(file));
  await Promise.all(
    filesToRemove.map(async (file) => {
      const filePath = join(localPackageDir, file);
      try {
        await remove(filePath);
        logger.debug(`Removed residual file: ${filePath}`);
      } catch (error) {
        logger.warn(`Failed to remove residual file ${filePath}: ${error}`);
      }
    })
  );

  // Write all files from the package
  await Promise.all(
    pkg.files.map(async (file) => {
      const targetPath = join(localPackageDir, file.path);
      const encoding = (file.encoding ?? 'utf8') as BufferEncoding;
      await writeTextFile(targetPath, file.content, encoding);
    })
  );
}

/**
 * Find package location in package.yml
 * Helper function for addPackageToYml
 */
async function findPackageLocation(
  cwd: string,
  packageName: string
): Promise<'packages' | 'dev-packages' | null> {
  const packageYmlPath = getLocalPackageYmlPath(cwd);
  
  if (!(await exists(packageYmlPath))) {
    return null;
  }
  
  try {
    const config = await parsePackageYml(packageYmlPath);
    
    // Check in packages array
    if (config.packages?.some(dep => arePackageNamesEquivalent(dep.name, packageName))) {
      return DEPENDENCY_ARRAYS.PACKAGES;
    }

    // Check in dev-packages array
    if (config[DEPENDENCY_ARRAYS.DEV_PACKAGES]?.some(dep => arePackageNamesEquivalent(dep.name, packageName))) {
      return DEPENDENCY_ARRAYS.DEV_PACKAGES;
    }
    
    return null;
  } catch (error) {
    logger.warn(`Failed to parse package.yml: ${error}`);
    return null;
  }
}
