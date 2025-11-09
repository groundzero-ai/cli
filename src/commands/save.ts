import { VERSION_TYPE_STABLE, WIP_SUFFIX } from './../core/save/constants.js';
import { Command } from 'commander';
import { SaveOptions, CommandResult } from '../types/index.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, ValidationError } from '../utils/errors.js';
import { addFormulaToYml } from '../utils/formula-management.js';
import { performPlatformSync } from '../core/sync/platform-sync.js';
import { parseFormulaInput, normalizeFormulaName } from '../utils/formula-name.js';
import { discoverFormulaFilesForSave } from '../core/save/save-file-discovery.js';
import { DEFAULT_VERSION, ERROR_MESSAGES, LOG_PREFIXES } from '../core/save/constants.js';
import { getOrCreateFormulaYml } from '../core/save/formula-yml-generator.js';
import { saveFormulaToRegistry } from '../core/save/formula-saver.js';
import { formulaVersionExists } from '../utils/formula-versioning.js';
import { applyWorkspaceFormulaRename } from '../core/save/workspace-rename.js';

/**
 * Main implementation of the save formula command
 * Now only supports specifying the formula name (optionally with @version)
 * @param formulaName - Formula name (optionally name@version)
 * @param versionType - Optional version type ('stable')
 * @param options - Command options (force, bump, etc.)
 * @returns Promise resolving to command result
 */
async function saveFormulaCommand(
  formulaName: string,
  versionType?: string,
  options?: SaveOptions
): Promise<CommandResult> {
  const cwd = process.cwd();

  // Parse inputs to determine the pattern being used
  const { name, version: explicitVersion } = parseFormulaInput(formulaName);

  const renameInput = options?.rename?.trim();
  let renameTarget: string | undefined;
  let renameVersion: string | undefined;

  if (renameInput) {
    const { name: renameName, version: renameVer } = parseFormulaInput(renameInput);
    const normalizedRename = normalizeFormulaName(renameName);
    if (normalizedRename !== name) {
      renameTarget = normalizedRename;
      renameVersion = renameVer;
      logger.debug(`Renaming formula during save`, { from: name, to: renameTarget, version: renameVersion });
    }
  }

  logger.debug(`Saving formula with name: ${name}`, { explicitVersion, options });

  // Initialize formula environment
  await ensureRegistryDirectories();

  // Get formula configuration based on input pattern
  // Use rename version if provided, otherwise use original version
  const formulaVersion = renameVersion || explicitVersion;
  let formulaInfo = await getOrCreateFormulaYml(cwd, name, formulaVersion, versionType, options?.bump, options?.force);
  let formulaConfig = formulaInfo.config;
  let isRootFormula = formulaInfo.isRootFormula;
  let targetVersion = formulaConfig.version;
  let isWipVersion = targetVersion.endsWith(WIP_SUFFIX);

  if (renameTarget) {
    if (!(options?.force || isWipVersion)) {
      const targetExists = await formulaVersionExists(renameTarget, targetVersion);
      if (targetExists) {
        throw new Error(`Version ${renameTarget}@${targetVersion} already exists. Use --force to overwrite.`);
      }
    }

    await applyWorkspaceFormulaRename(cwd, formulaInfo, renameTarget);

    // Re-fetch formula info at the new location with the same target version
    formulaInfo = await getOrCreateFormulaYml(
      cwd,
      renameTarget,
      targetVersion,
      versionType,
      undefined,
      /* force */ true
    );
    formulaConfig = formulaInfo.config;
    isRootFormula = formulaInfo.isRootFormula;
    targetVersion = formulaConfig.version;
    isWipVersion = targetVersion.endsWith(WIP_SUFFIX);
  }

  // Discover and process files directly into formula files array
  const formulaFiles = await discoverFormulaFilesForSave(formulaInfo, {
    force: options?.force || isWipVersion
  });

  // Save formula to local registry
  const saveResult = await saveFormulaToRegistry(formulaInfo, formulaFiles);

  if (!saveResult.success) {
    return { success: false, error: saveResult.error || ERROR_MESSAGES.SAVE_FAILED };
  }

  // Sync universal files across detected platforms using planner-based workflow
  const syncResult = await performPlatformSync(
    cwd,
    formulaConfig.name,
    formulaConfig.version,
    formulaFiles,
    {
      force: options?.force,
      conflictStrategy: options?.force ? 'overwrite' : 'ask'
    }
  );

  // Finalize the save operation
  // Don't add root formula to itself as a dependency
  if (!options?.skipProjectLink && !isRootFormula) {
    await addFormulaToYml(cwd, formulaConfig.name, formulaConfig.version, /* isDev */ false, /* originalVersion */ undefined, /* silent */ true);
  }
  
  // Display appropriate message based on formula type
  const formulaType = isRootFormula ? 'root formula' : 'formula';
  console.log(`${LOG_PREFIXES.SAVED} ${formulaConfig.name}@${formulaConfig.version} (${formulaType}, ${formulaFiles.length} files):`);
  if (formulaFiles.length > 0) {
    const savedPaths = formulaFiles.map(f => f.path);
    const sortedSaved = [...savedPaths].sort((a, b) => a.localeCompare(b));
    for (const savedPath of sortedSaved) {
      console.log(`   ├── ${savedPath}`);
    }
  }

  // Display platform sync results
  const totalCreated = syncResult.created.length;
  const totalUpdated = syncResult.updated.length;
  const totalDeleted = syncResult.deleted?.length ?? 0;

  if (totalCreated > 0) {
    const allCreated = [...syncResult.created].sort((a, b) => a.localeCompare(b));
    console.log(`✓ Platform sync created ${totalCreated} files:`);
    for (const createdFile of allCreated) {
      console.log(`   ├── ${createdFile}`);
    }
  }

  if (totalUpdated > 0) {
    const allUpdated = [...syncResult.updated].sort((a, b) => a.localeCompare(b));
    console.log(`✓ Platform sync updated ${totalUpdated} files:`);
    for (const updatedFile of allUpdated) {
      console.log(`   ├── ${updatedFile}`);
    }
  }

  if (totalDeleted > 0 && syncResult.deleted) {
    const allDeleted = [...syncResult.deleted].sort((a, b) => a.localeCompare(b));
    console.log(`✓ Platform sync removed ${totalDeleted} files:`);
    for (const deletedFile of allDeleted) {
      console.log(`   ├── ${deletedFile}`);
    }
  }

  return { success: true, data: formulaConfig };
}


/**
 * Setup the save command
 */
export function setupSaveCommand(program: Command): void {
  program
    .command('save')
    .alias('s')
    .argument('<formula-name>', 'formula name (optionally formula-name@version)')
    .argument('[version-type]', 'version type: stable (optional)')
    .description('Save a formula to local registry.\n' +
      'Usage:\n' +
      '  g0 save <formula-name>                # Detects files and saves to registry\n' +
      '  g0 save <formula-name> stable        # Save as stable version (with optional --bump)\n' +
      'Auto-generates local dev versions by default.')
    .option('-f, --force', 'overwrite existing version or skip confirmations')
    .option('-b, --bump <type>', `bump version (patch|minor|major). Creates prerelease by default, stable when combined with "${VERSION_TYPE_STABLE}" argument`)
    .option('--rename <newName>', 'Rename formula during save (optionally newName@version)')
    .action(withErrorHandling(async (formulaName: string, versionType?: string, options?: SaveOptions) => {
      // Validate version type argument
      if (versionType && versionType !== VERSION_TYPE_STABLE) {
        throw new ValidationError(ERROR_MESSAGES.INVALID_VERSION_TYPE.replace('%s', versionType).replace('%s', VERSION_TYPE_STABLE));
      }

      const result = await saveFormulaCommand(formulaName, versionType, options);
      if (!result.success) {
        throw new Error(result.error || 'Save operation failed');
      }
    }));
}
