import { dirname } from 'path';

import { FILE_PATTERNS } from '../../constants/index.js';
import { discoverPlatformFilesUnified } from '../discovery/platform-files-discovery.js';
import { discoverAllRootFiles } from '../../utils/package-discovery.js';
import { PackageYmlInfo } from './package-yml-generator.js';
import { extractPackageSection, buildOpenMarker, buildOpenMarkerRegex } from '../../utils/root-file-extractor.js';
import { readTextFile, writeTextFile, exists, renameDirectory, removeEmptyDirectories } from '../../utils/fs.js';
import { writePackageYml, parsePackageYml } from '../../utils/package-yml.js';
import { getLocalPackageDir, getLocalPackageYmlPath, getLocalPackagesDir } from '../../utils/paths.js';
import { arePackageNamesEquivalent } from '../../utils/package-name.js';
import { logger } from '../../utils/logger.js';

/**
 * Apply formula rename changes directly to workspace files prior to save.
 * Updates formula.yml, markdown frontmatter, index.yml entries, root markers,
 * formula directory, and root formula.yml dependencies.
 */
export async function applyWorkspacePackageRename(
  cwd: string,
  formulaInfo: PackageYmlInfo,
  newName: string
): Promise<void> {
  const currentName = formulaInfo.config.name;
  if (currentName === newName) return;

  logger.debug(`Renaming workspace formula files`, { from: currentName, to: newName, cwd });

  // Update formula.yml with the new name before further processing
  const updatedConfig = { ...formulaInfo.config, name: newName };
  await writePackageYml(formulaInfo.fullPath, updatedConfig);

  // Frontmatter and index.yml support removed - no metadata updates needed

  // Update root files containing formula markers
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

  // Update root formula.yml dependencies (project formula.yml)
  await updateRootPackageYmlDependencies(cwd, currentName, newName);

  // For sub-formulas, move the directory to the new normalized name
  if (!formulaInfo.isRootPackage) {
    const currentDir = dirname(formulaInfo.fullPath);
    const targetDir = getLocalPackageDir(cwd, newName);

    if (currentDir !== targetDir) {
      if (await exists(targetDir)) {
        throw new Error(`Cannot rename formula: target directory already exists at ${targetDir}`);
      }
      await renameDirectory(currentDir, targetDir);

      // Clean up empty directories left after the move (e.g., empty @scope directories)
      const formulasDir = getLocalPackagesDir(cwd);
      if (await exists(formulasDir)) {
        await removeEmptyDirectories(formulasDir);
      }
    }
  }
}

/**
 * Update dependencies on the old formula name to the new name in root formula.yml
 */
async function updateRootPackageYmlDependencies(
  cwd: string,
  oldName: string,
  newName: string
): Promise<void> {
  const rootPackageYmlPath = getLocalPackageYmlPath(cwd);

  if (!(await exists(rootPackageYmlPath))) {
    return; // No root formula.yml to update
  }

  try {
    const config = await parsePackageYml(rootPackageYmlPath);
    let updated = false;

    // Update dependencies in formulas array
    if (config.formulas) {
      for (const dep of config.formulas) {
        if (arePackageNamesEquivalent(dep.name, oldName)) {
          dep.name = newName;
          updated = true;
        }
      }
    }

    // Update dependencies in dev-formulas array
    if (config['dev-formulas']) {
      for (const dep of config['dev-formulas']) {
        if (arePackageNamesEquivalent(dep.name, oldName)) {
          dep.name = newName;
          updated = true;
        }
      }
    }

    if (updated) {
      await writePackageYml(rootPackageYmlPath, config);
      logger.debug(`Updated root formula.yml dependencies from ${oldName} to ${newName}`);
    }
  } catch (error) {
    logger.warn(`Failed to update root formula.yml dependencies: ${error}`);
  }
}

