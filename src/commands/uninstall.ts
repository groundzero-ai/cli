import { Command } from 'commander';
import { join, relative, dirname } from 'path';
import { readdir } from 'fs/promises';
import { UninstallOptions, CommandResult } from '../types/index.js';
import { parsePackageYml, writePackageYml } from '../utils/package-yml.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { discoverPackageFilesForUninstall } from '../core/uninstall/uninstall-file-discovery.js';
import { buildDependencyTree, findDanglingDependencies } from '../core/dependency-resolver.js';
import { exists, remove, removeEmptyDirectories } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, ValidationError } from '../utils/errors.js';
import { arePackageNamesEquivalent, validatePackageName } from '../utils/package-name.js';
import {
  FILE_PATTERNS,
  DEPENDENCY_ARRAYS,
} from '../constants/index.js';
import { getLocalPackageYmlPath, getAIDir, getLocalPackagesDir, getLocalPackageDir } from '../utils/paths.js';
import { computeRootFileRemovalPlan, applyRootFileRemovals } from '../utils/root-file-uninstaller.js';
import { normalizePathForProcessing } from '../utils/path-normalization.js';
import { getAllPlatformDirs } from '../utils/platform-utils.js';

// Centralized discovery is used instead of bespoke platform iteration

/**
 * Get protected packages from cwd package.yml
 */
async function getProtectedPackages(targetDir: string): Promise<Set<string>> {
  const protectedPackages = new Set<string>();
  
  const packageYmlPath = getLocalPackageYmlPath(targetDir);
  if (!(await exists(packageYmlPath))) return protectedPackages;
  
  try {
    const config = await parsePackageYml(packageYmlPath);
    
    // Add all packages and dev-packages to protected set
    const allDeps = [
      ...(config.packages || []),
      ...(config['dev-packages'] || [])
    ];
    
    allDeps.forEach(dep => protectedPackages.add(dep.name));
    logger.debug(`Protected packages: ${Array.from(protectedPackages).join(', ')}`);
  } catch (error) {
    logger.warn(`Failed to parse package.yml for protected packages: ${error}`);
  }
  
  return protectedPackages;
}

/**
 * Remove package from package.yml file
 */
async function removePackageFromYml(targetDir: string, packageName: string): Promise<boolean> {
  // Check for .openpackage/package.yml
  const configPaths = [
    getLocalPackageYmlPath(targetDir)
  ];
  
  let configPath: string | null = null;
  for (const path of configPaths) {
    if (await exists(path)) {
      configPath = path;
      break;
    }
  }
  
  if (!configPath) {
    logger.warn('No package.yml file found to update');
    return false;
  }
  
  try {
    const config = await parsePackageYml(configPath);
    let removed = false;
    
    // Remove from both packages and dev-packages arrays
    const sections = [DEPENDENCY_ARRAYS.PACKAGES, DEPENDENCY_ARRAYS.DEV_PACKAGES] as const;
    for (const section of sections) {
      if (config[section]) {
        const initialLength = config[section].length;
        config[section] = config[section].filter(dep => !arePackageNamesEquivalent(dep.name, packageName));
        if (config[section].length < initialLength) {
          removed = true;
          logger.info(`Removed ${packageName} from ${section}`);
        }
      }
    }
    
    if (removed) {
      await writePackageYml(configPath, config);
      return true;
    } else {
      logger.warn(`Package ${packageName} not found in dependencies`);
      return false;
    }
  } catch (error) {
    logger.error(`Failed to update package.yml: ${error}`);
    return false;
  }
}

/**
 * Display dry run information
 */
async function displayDryRunInfo(
  packageName: string,
  cwd: string,
  targetDir: string,
  options: UninstallOptions,
  danglingDependencies: Set<string>,
  openpackagePath: string,
  packagesToRemove: string[]
): Promise<void> {
  console.log(`🔍 Dry run - showing what would be uninstalled:\n`);

  console.log(`📦 Packages to remove: ${packagesToRemove.length}`);
  console.log(`├── Main: ${packageName}`);
  if (danglingDependencies.size > 0) {
    for (const dep of danglingDependencies) {
      console.log(`├── Dependency: ${dep}`);
    }
  }


  // Check package.yml files and README.md files that would be removed
  const packageYmlFilesToRemove: string[] = [];
  const readmeFilesToRemove: string[] = [];
  for (const pkg of packagesToRemove) {
    const packageDir = getLocalPackageDir(cwd, pkg);
    const packageYmlPath = join(packageDir, FILE_PATTERNS.PACKAGE_YML);
    const readmePath = join(packageDir, FILE_PATTERNS.README_MD);
    if (await exists(packageYmlPath)) {
      packageYmlFilesToRemove.push(pkg);
    }
    if (await exists(readmePath)) {
      readmeFilesToRemove.push(pkg);
    }
  }

  const totalMetadataFiles = packageYmlFilesToRemove.length + readmeFilesToRemove.length;
  if (totalMetadataFiles > 0) {
    console.log(`\n📄 Package metadata to remove (${totalMetadataFiles}):`);
    for (const pkg of packageYmlFilesToRemove) {
      console.log(`├── ${pkg}/package.yml`);
    }
    for (const pkg of readmeFilesToRemove) {
      console.log(`├── ${pkg}/README.md`);
    }
  } else {
    console.log(`\n📄 Package metadata to remove: none`);
  }
  
  console.log('');

  // Root files that would be updated or deleted
  const rootPlan = await computeRootFileRemovalPlan(cwd, packagesToRemove);
  console.log(`📝 Root files to update: ${rootPlan.toUpdate.length}`);
  for (const f of rootPlan.toUpdate.sort((a, b) => a.localeCompare(b))) {
    console.log(`   ├── ${f}`);
  }
  
  // Check platform files that would be cleaned up for all packages
  const discoveredByPackage = await Promise.all(
    packagesToRemove.map(async (name) => ({ name, files: await discoverPackageFilesForUninstall(name) }))
  );
  const platformCleanup: Record<string, string[]> = {};
  const seen = new Set<string>();
  for (const { files } of discoveredByPackage) {
    for (const f of files) {
      if (f.isRootFile) continue;
      if (seen.has(f.fullPath)) continue;
      seen.add(f.fullPath);
      const rel = normalizePathForProcessing(relative(cwd, f.fullPath));
      const platform = f.sourceDir;
      if (!platformCleanup[platform]) platformCleanup[platform] = [];
      platformCleanup[platform].push(rel);
    }
  }

  // Display total files that would be removed
  const allFilesToRemove = [];
  for (const platformFiles of Object.values(platformCleanup)) {
    allFilesToRemove.push(...platformFiles);
  }
  const sortedAllFilesToRemove = allFilesToRemove.sort((a, b) => a.localeCompare(b));
  console.log(`🗑️  Files to remove: ${allFilesToRemove.length}`);
  for (const file of sortedAllFilesToRemove) {
    console.log(`   ├── ${file}`);
  }

  // Check package.yml updates
  const configPaths = [
    getLocalPackageYmlPath(targetDir)
  ];

  const hasConfigFile = await Promise.all(configPaths.map(path => exists(path)));
  if (hasConfigFile.some(exists => exists)) {
    console.log(`📋 Would attempt to remove packages from package dependencies:`);
    for (const pkg of packagesToRemove) {
      console.log(`├── ${pkg}`);
    }
  } else {
    console.log('📋 No package.yml file to update');
  }

}


/**
 * Display uninstall success information
 */
function displayUninstallSuccess(
  packageName: string,
  targetDir: string,
  options: UninstallOptions,
  danglingDependencies: Set<string>,
  removedAiFiles: string[],
  ymlRemovalResults: Record<string, boolean>,
  platformCleanup: Record<string, string[]>,
  updatedRootFiles: string[]
): void {
  console.log(`✓ Package '${packageName}' uninstalled successfully`);
  console.log(`📁 Target directory: ${targetDir}`);

  // Collect all removed files
  const allRemovedFiles: string[] = [];

  // Add AI files
  allRemovedFiles.push(...removedAiFiles);

  // Add platform files individually
  for (const platformFiles of Object.values(platformCleanup)) {
    allRemovedFiles.push(...platformFiles);
  }

  // Display removed files count and list
  const sortedRemovedFiles = allRemovedFiles.sort((a, b) => a.localeCompare(b));
  console.log(`🗑️  Removed files: ${allRemovedFiles.length}`);
  for (const file of sortedRemovedFiles) {
    console.log(`   ├── ${file}`);
  }

  // Display updated root files
  if (updatedRootFiles.length > 0) {
    console.log(`📝 Updated root files:`);
    for (const f of updatedRootFiles.sort((a, b) => a.localeCompare(b))) {
      console.log(`   ├── ${f}`);
    }
  }

  // Report package.yml updates
  const successfulRemovals = Object.entries(ymlRemovalResults).filter(([, success]) => success);
  const failedRemovals = Object.entries(ymlRemovalResults).filter(([, success]) => !success);

  if (successfulRemovals.length > 0) {
    console.log(`📋 Removed from package dependencies:`);
    for (const [pkg] of successfulRemovals) {
      console.log(`   ├── ${pkg}`);
    }
  }

  if (failedRemovals.length > 0) {
    console.log(`⚠️  Could not update package.yml for:`);
    for (const [pkg] of failedRemovals) {
      console.log(`   ├── ${pkg} (not found or not listed)`);
    }
  }

}

/**
 * Uninstall package command implementation with recursive dependency resolution
 */
async function uninstallPackageCommand(
  packageName: string,
  targetDir: string,
  options: UninstallOptions
): Promise<CommandResult> {
  validatePackageName(packageName);

  logger.info(`Uninstalling package '${packageName}' from: ${targetDir}`, { options });
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  const cwd = process.cwd();
  const aiRootPath = getAIDir(cwd);
  const openpackagePath = targetDir && targetDir !== '.'
    ? join(aiRootPath, targetDir.startsWith('/') ? targetDir.slice(1) : targetDir)
    : aiRootPath;
  

  // Helper now available in fs utils: removeEmptyDirectories
  
  // Determine what packages to remove
  let packagesToRemove = [packageName];
  let danglingDependencies: Set<string> = new Set();
  
  if (options.recursive) {
    // Build dependency tree and find dangling dependencies
    const protectedPackages = await getProtectedPackages(cwd);
    const dependencyTree = await buildDependencyTree(cwd, protectedPackages);
    danglingDependencies = await findDanglingDependencies(packageName, dependencyTree);
    
    packagesToRemove = [packageName, ...Array.from(danglingDependencies)];
    
    if (danglingDependencies.size > 0) {
      console.log(`\n📦 Recursive uninstall mode - found ${danglingDependencies.size} dangling dependencies:`);
      for (const dep of danglingDependencies) {
        console.log(`├── ${dep}`);
      }
      console.log(`\n🔍 Total packages to remove: ${packagesToRemove.length}`);
    } else {
      console.log(`\n📦 Recursive uninstall mode - no dangling dependencies found`);
    }
  }
  
  // Dry run mode
  if (options.dryRun) {
    await displayDryRunInfo(packageName, cwd, targetDir, options, danglingDependencies, openpackagePath, packagesToRemove);
    const rootPlan = await computeRootFileRemovalPlan(cwd, packagesToRemove);
    
    // Build platform cleanup summary via centralized discovery across all packages
    const discoveredByPackage = await Promise.all(
      packagesToRemove.map(async (name) => ({ name, files: await discoverPackageFilesForUninstall(name) }))
    );
    const platformCleanup: Record<string, string[]> = {};
    const seen = new Set<string>();
    for (const { files } of discoveredByPackage) {
      for (const f of files) {
        if (f.isRootFile) continue;
        if (seen.has(f.fullPath)) continue;
        seen.add(f.fullPath);
        const rel = normalizePathForProcessing(relative(cwd, f.fullPath));
        const platform = f.sourceDir;
        if (!platformCleanup[platform]) platformCleanup[platform] = [];
        platformCleanup[platform].push(rel);
      }
    }
    return {
      success: true,
      data: {
        dryRun: true,
        packageName,
        targetDir,
        recursive: options.recursive,
        danglingDependencies: Array.from(danglingDependencies),
        totalToRemove: packagesToRemove.length,
        platformCleanup,
        rootFiles: { toUpdate: rootPlan.toUpdate }
      }
    };
  }
  
  // Perform actual uninstallation
  try {
    const removedAiFiles: string[] = [];

    // Remove empty directories under ai target path (if it exists)
    if (await exists(openpackagePath)) {
      await removeEmptyDirectories(openpackagePath);
    }

    // Discover platform-specific files BEFORE removing package directories (to access package.index.yml files)
    const discoveredByPackage = await Promise.all(
      packagesToRemove.map(async (name) => ({ name, files: await discoverPackageFilesForUninstall(name) }))
    );

    // Remove package.yml files and directories for all packages being removed
    const packagesDir = getLocalPackagesDir(cwd);
    for (const pkg of packagesToRemove) {
      const packageDir = getLocalPackageDir(cwd, pkg);
      const packageYmlPath = join(packageDir, FILE_PATTERNS.PACKAGE_YML);

      // Remove the package.yml file if it exists
      if (await exists(packageYmlPath)) {
        await remove(packageYmlPath);
        logger.debug(`Removed package.yml file: ${packageYmlPath}`);
      }

      // Remove the package directory if it exists
      if (await exists(packageDir)) {
        await remove(packageDir);
        logger.debug(`Removed package directory: ${packageDir}`);
      }
    }

    // Remove empty directories under .openpackage/packages
    if (await exists(packagesDir)) {
      await removeEmptyDirectories(packagesDir);
    }

    // Now remove the discovered platform-specific files
    const platformCleanup: Record<string, string[]> = {};
    const seen = new Set<string>();
    for (const { files } of discoveredByPackage) {
      for (const f of files) {
        if (f.isRootFile) continue; // Root files handled separately
        if (seen.has(f.fullPath)) continue; // Dedupe
        seen.add(f.fullPath);
        if (await exists(f.fullPath)) {
          await remove(f.fullPath);
          const rel = normalizePathForProcessing(relative(cwd, f.fullPath));
          const platform = f.sourceDir;
          if (!platformCleanup[platform]) platformCleanup[platform] = [];
          platformCleanup[platform].push(rel);
        }
      }
    }
    
    // Remove or update root files by stripping package sections
    const rootRemoval = await applyRootFileRemovals(cwd, packagesToRemove);

    // Final pass: remove empty directories left after file deletions
    const platformRootDirs = new Set(getAllPlatformDirs().map(dir => join(cwd, dir)));
    const dirsChecked = new Set<string>();

    // Helper function to remove directory if empty (and not platform root)
    async function removeIfEmpty(dirPath: string): Promise<boolean> {
      if (platformRootDirs.has(dirPath)) return false;
      if (dirsChecked.has(dirPath)) return false;
      dirsChecked.add(dirPath);

      try {
        const entries = await readdir(dirPath);
        if (entries.length === 0) {
          await remove(dirPath);
          return true;
        }
      } catch (error) {
        // Directory doesn't exist or can't be read
        return false;
      }
      return false;
    }

    // Collect all parent directories from deleted files
    const parentDirs = new Set<string>();

    // From platform file deletions
    for (const files of Object.values(platformCleanup)) {
      for (const relPath of files) {
        const absolutePath = relPath.startsWith('/') ? relPath : join(cwd, relPath);
        let currentDir = dirname(absolutePath);
        while (currentDir !== dirname(currentDir)) { // Stop at root
          if (!platformRootDirs.has(currentDir)) {
            parentDirs.add(currentDir);
          } else {
            break; // Stop at platform root
          }
          currentDir = dirname(currentDir);
        }
      }
    }


    // Remove directories from bottom up (deepest first)
    const sortedDirs = Array.from(parentDirs).sort((a, b) => b.length - a.length);
    for (const dir of sortedDirs) {
      await removeIfEmpty(dir);
    }

    // Clean up package directories as before
    if (await exists(packagesDir)) {
      await removeEmptyDirectories(packagesDir);
    }
    if (await exists(openpackagePath)) {
      await removeEmptyDirectories(openpackagePath);
    }

    // Remove all packages being uninstalled from package.yml
    const ymlRemovalResults: Record<string, boolean> = {};
    for (const pkg of packagesToRemove) {
      ymlRemovalResults[pkg] = await removePackageFromYml(cwd, pkg);
    }
    const removedFromYml = ymlRemovalResults[packageName];

    // Success output
    displayUninstallSuccess(
      packageName,
      targetDir,
      options,
      danglingDependencies,
      removedAiFiles,
      ymlRemovalResults,
      platformCleanup,
      rootRemoval.updated
    );

    return {
      success: true,
      data: {
        packageName,
        targetDir,
        aiFiles: removedAiFiles,
        ymlRemovalResults,
        recursive: options.recursive,
        danglingDependencies: Array.from(danglingDependencies),
        totalRemoved: removedAiFiles.length,
        platformCleanup,
        rootFiles: { updated: rootRemoval.updated }
      }
    };
  } catch (error) {
    logger.error(`Failed to uninstall package '${packageName}': ${error}`);
    throw new ValidationError(`Failed to uninstall package: ${error}`);
  }
}

/**
 * Setup the uninstall command
 */
export function setupUninstallCommand(program: Command): void {
  program
    .command('uninstall')
    .alias('un')
    .description('Remove a package from the ai directory and update dependencies')
    .argument('<package-name>', 'name of the package to uninstall')
    .argument('[target-dir]', 'target directory (defaults to current directory)', '.')
    .option('--dry-run', 'preview changes without applying them')
    .option('--recursive', 'recursively remove dangling dependencies (packages not depended upon by any remaining packages, excluding those listed in cwd package.yml)')
    .action(withErrorHandling(async (packageName: string, targetDir: string, options: UninstallOptions) => {
      const result = await uninstallPackageCommand(packageName, targetDir, options);
      if (!result.success && result.error !== 'Package not found') {
        throw new Error(result.error || 'Uninstall operation failed');
      }
    }));
}
