import { VERSION_TYPE_STABLE } from './../core/save/constants.js';
import { Command } from 'commander';
import { SaveOptions, CommandResult } from '../types/index.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, ValidationError } from '../utils/errors.js';
import { addFormulaToYml } from '../utils/formula-management.js';
import { getInstalledFormulaVersion } from '../core/groundzero.js';
import { createCaretRange } from '../utils/version-ranges.js';
import { getLatestFormulaVersion } from '../core/directory.js';
import { performPlatformSync } from '../core/save/platform-sync.js';
import { parseFormulaInput } from '../utils/formula-name.js';
import { discoverFormulaFilesForSave } from '../core/save/save-file-discovery.js';
import { createFormulaFiles } from '../core/save/formula-file-generator.js';
import { DEFAULT_VERSION, ERROR_MESSAGES, LOG_PREFIXES } from '../core/save/constants.js';
import { extractBaseVersion } from '../utils/version-generator.js';
import {  getOrCreateFormulaYmlInfo } from '../core/save/formula-yml-generator.js';
import { saveFormulaToRegistry } from '../core/save/formula-saver.js';


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

  // Early include/dev-include validation and pre-save (only for top-level invocations)
  const includeList = options?.include ?? [];
  const includeDevList = options?.includeDev ?? [];
  const hasIncludes = includeList.length > 0 || includeDevList.length > 0;

  if (hasIncludes) {
    // Validate existence first
    const uniqueNames = new Set<string>([...includeList, ...includeDevList]);
    for (const dep of uniqueNames) {
      // TODO: Bad logic, needs to be refactored
      // const matches = await findFormulas(dep);
      // if (!matches || matches.length === 0) {
      //   throw new ValidationError(`${dep} not found, please create or install it first.`);
      // }
    }

    // Pre-save all included formulas first (skip linking to avoid premature writes)
    for (const dep of uniqueNames) {
      const res = await saveFormulaCommand(dep, undefined, {
        force: options?.force,
        bump: options?.bump,
        skipProjectLink: true
      });
      if (!res.success) {
        return res;
      }
    }
  }

  // Parse inputs to determine the pattern being used
  const { name, version: explicitVersion } = parseFormulaInput(formulaName);

  logger.debug(`Saving formula with name: ${name}`, { explicitVersion, options });

  // Initialize formula environment
  await ensureRegistryDirectories();

  // Get formula configuration based on input pattern
  const formulaInfo = await getOrCreateFormulaYmlInfo(cwd, name, explicitVersion, versionType, options?.bump);
  const formulaConfig = formulaInfo.config;
  const isRootFormula = formulaInfo.isRootFormula;

  // Inject includes into this formula's own formula.yml (dependencies)
  if (hasIncludes) {
    // Filter out self-references for root formulas
    const filteredIncludes = includeList.filter(dep => dep !== formulaConfig.name);
    const filteredDevIncludes = includeDevList.filter(dep => dep !== formulaConfig.name);

    // Warn if self-references were filtered
    const selfReferences = [...includeList, ...includeDevList].filter(dep => dep === formulaConfig.name);
    if (selfReferences.length > 0) {
      logger.warn(`Skipping self-reference: ${formulaConfig.name} cannot depend on itself`);
    }

    // Ensure arrays exist
    if (!formulaConfig.formulas) formulaConfig.formulas = [];
    if (!formulaConfig['dev-formulas']) formulaConfig['dev-formulas'] = [];

    // Helper to upsert dependency into a target array
    const upsertDependency = (arr: { name: string; version: string }[], name: string, versionRange: string) => {
      const idx = arr.findIndex(d => d.name === name);
      if (idx >= 0) {
        arr[idx] = { name, version: versionRange };
      } else {
        arr.push({ name, version: versionRange });
      }
    };

    // Build caret versions from installed or latest local registry
    const computeCaretRange = async (dep: string): Promise<string> => {
      const installed = await getInstalledFormulaVersion(dep, cwd);
      let version = installed || await getLatestFormulaVersion(dep) || DEFAULT_VERSION;
      const base = extractBaseVersion(version);
      return createCaretRange(base);
    };

    // First: add normal includes to formulas
    for (const dep of filteredIncludes) {
      const range = await computeCaretRange(dep);
      upsertDependency(formulaConfig.formulas!, dep, range);
    }

    // Then: add dev includes to dev-formulas and remove from formulas if present
    for (const dep of filteredDevIncludes) {
      const range = await computeCaretRange(dep);
      upsertDependency((formulaConfig as any)['dev-formulas']!, dep, range);
      const idx = formulaConfig.formulas!.findIndex(d => d.name === dep);
      if (idx >= 0) {
        formulaConfig.formulas!.splice(idx, 1);
      }
    }
  }

  // Discover and include MD files using appropriate logic
  const discoveredFiles = await discoverFormulaFilesForSave(formulaConfig.name);

  // Process discovered files and create formula files array
  const formulaFiles = await createFormulaFiles(formulaInfo, discoveredFiles);

  // Save formula to local registry
  const saveResult = await saveFormulaToRegistry(formulaInfo, formulaFiles);

  if (!saveResult.success) {
    return { success: false, error: saveResult.error || ERROR_MESSAGES.SAVE_FAILED };
  }

  // Sync universal files across detected platforms
  const syncResult = await performPlatformSync(cwd, formulaConfig.name, formulaFiles);

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

  return { success: true, data: formulaConfig };
}


/**
 * Setup the save command
 */
export function setupSaveCommand(program: Command): void {
  program
    .command('save')
    .argument('<formula-name>', 'formula name (optionally formula-name@version)')
    .argument('[version-type]', 'version type: stable (optional)')
    .description('Save a formula to local registry.\n' +
      'Usage:\n' +
      '  g0 save <formula-name>                # Detects files and saves to registry\n' +
      '  g0 save <formula-name> stable        # Save as stable version (with optional --bump)\n' +
      'Auto-generates local dev versions by default.')
    .option('-f, --force', 'overwrite existing version or skip confirmations')
    .option('-b, --bump <type>', `bump version (patch|minor|major). Creates prerelease by default, stable when combined with "${VERSION_TYPE_STABLE}" argument`)
    .option('--include <names...>', 'Include formulas into main formula.yml')
    .option('--include-dev <names...>', 'Include dev formulas into main formula.yml')
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
