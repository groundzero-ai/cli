import { dirname } from 'path';

import { discoverAllRootFiles } from '../../utils/package-discovery.js';
import { type PackageContext } from '../package-context.js';
import { extractPackageSection, buildOpenMarker, buildOpenMarkerRegex } from '../../utils/root-file-extractor.js';
import { readTextFile, writeTextFile, exists, renameDirectory, removeEmptyDirectories } from '../../utils/fs.js';
import { writePackageYml, parsePackageYml } from '../../utils/package-yml.js';
import { getLocalPackageDir, getLocalPackageYmlPath, getLocalPackagesDir } from '../../utils/paths.js';
import { arePackageNamesEquivalent } from '../../utils/package-name.js';
import { logger } from '../../utils/logger.js';

/**
 * Apply package rename changes directly to workspace files prior to save.
 * Updates package.yml, markdown frontmatter, index.yml entries, root markers,
 * package directory, and root package.yml dependencies.
 */
export async function applyWorkspacePackageRename(
  cwd: string,
  packageContext: PackageContext,
  newName: string
): Promise<void> {
  const currentName = packageContext.config.name;
  if (currentName === newName) return;

  logger.debug(`Renaming workspace package files`, { from: currentName, to: newName, cwd });

  // Update package.yml with the new name before further processing
  const updatedConfig = { ...packageContext.config, name: newName };
  await writePackageYml(packageContext.packageYmlPath, updatedConfig);

  // Frontmatter and index.yml support removed - no metadata updates needed

  // Update root files containing package markers
  const rootFiles = await discoverAllRootFiles(cwd, currentName);
  for (const rootFile of rootFiles) {
    const originalContent = await readTextFile(rootFile.fullPath);
    const extracted = extractPackageSection(originalContent, currentName);
    if (!extracted) {
      continue;
    }

    const openRegex = buildOpenMarkerRegex(currentName);
    const desiredOpenMarker = buildOpenMarker(newName);
    const replacedContent = originalContent.replace(openRegex, desiredOpenMarker);

    if (replacedContent !== originalContent) {
      await writeTextFile(rootFile.fullPath, replacedContent);
    }
  }

  // Update root package.yml dependencies (project package.yml)
  await updateRootPackageYmlDependencies(cwd, currentName, newName);

  // For sub-packages, move the directory to the new normalized name
  if (packageContext.location !== 'root') {
    const currentDir = dirname(packageContext.packageYmlPath);
    const targetDir = getLocalPackageDir(cwd, newName);

    if (currentDir !== targetDir) {
      if (await exists(targetDir)) {
        throw new Error(`Cannot rename package: target directory already exists at ${targetDir}`);
      }
      await renameDirectory(currentDir, targetDir);

      // Clean up empty directories left after the move (e.g., empty @scope directories)
      const packagesDir = getLocalPackagesDir(cwd);
      if (await exists(packagesDir)) {
        await removeEmptyDirectories(packagesDir);
      }
    }
  }
}

/**
 * Update dependencies on the old package name to the new name in root package.yml
 */
async function updateRootPackageYmlDependencies(
  cwd: string,
  oldName: string,
  newName: string
): Promise<void> {
  const rootPackageYmlPath = getLocalPackageYmlPath(cwd);

  if (!(await exists(rootPackageYmlPath))) {
    return; // No root package.yml to update
  }

  try {
    const config = await parsePackageYml(rootPackageYmlPath);
    let updated = false;

    // Update dependencies in packages array
    if (config.packages) {
      for (const dep of config.packages) {
        if (arePackageNamesEquivalent(dep.name, oldName)) {
          dep.name = newName;
          updated = true;
        }
      }
    }

    // Update dependencies in dev-packages array
    if (config['dev-packages']) {
      for (const dep of config['dev-packages']) {
        if (arePackageNamesEquivalent(dep.name, oldName)) {
          dep.name = newName;
          updated = true;
        }
      }
    }

    if (updated) {
      await writePackageYml(rootPackageYmlPath, config);
      logger.debug(`Updated root package.yml dependencies from ${oldName} to ${newName}`);
    }
  } catch (error) {
    logger.warn(`Failed to update root package.yml dependencies: ${error}`);
  }
}

