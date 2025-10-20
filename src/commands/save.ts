import { UTF8_ENCODING, VERSION_TYPE_STABLE } from './../core/save/constants';
import { Command } from 'commander';
import { join } from 'path';
import { SaveOptions, CommandResult, FormulaYml, FormulaFile } from '../types/index.js';
import { parseFormulaYml, writeFormulaYml } from '../utils/formula-yml.js';
import { ensureRegistryDirectories, getFormulaVersionPath } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, ValidationError } from '../utils/errors.js';
import { ensureLocalGroundZeroStructure, createBasicFormulaYml, addFormulaToYml } from '../utils/formula-management.js';
import { FILE_PATTERNS } from '../constants/index.js';

import { resolveTargetDirectory, resolveTargetFilePath } from '../utils/platform-mapper.js';
import { getInstalledFormulaVersion } from '../core/groundzero.js';
import { createCaretRange } from '../utils/version-ranges.js';
import { getLatestFormulaVersion } from '../core/directory.js';
import { exists, writeTextFile, ensureDir } from '../utils/fs.js';
import { postSavePlatformSync } from '../utils/platform-sync.js';
import { syncRootFiles } from '../utils/root-file-sync.js';
import { getLocalFormulaYmlPath } from '../utils/paths.js';
import { validateFormulaName, SCOPED_FORMULA_REGEX } from '../utils/formula-validation.js';
import { normalizeFormulaName, areFormulaNamesEquivalent } from '../utils/formula-name-normalization.js';
import { discoverFormulaFiles } from '../core/discovery/formula-files-discovery.js';
import { createFormulaFiles } from '../core/save/formula-file-generator.js';
import { DEFAULT_VERSION, ERROR_MESSAGES, LOG_PREFIXES } from '../core/save/constants.js';
import { extractBaseVersion } from '../utils/version-generator';
import {  getOrCreateFormulaYmlInfo } from '../core/save/formula-yml-generator';
import { saveFormulaToRegistry } from '../core/save/formula-saver';

/**
 * Parse formula inputs to handle three usage patterns:
 * Only support formula name input patterns now:
 * - formula-name
 * - formula-name@version
 */
function parseFormulaInputs(formulaName: string): {
  name: string;
  version?: string;
} {
  // Check if this looks like a scoped formula name (@scope/name)
  // Handle this before path normalization to avoid treating it as a directory
  const scopedMatch = formulaName.match(SCOPED_FORMULA_REGEX);
  if (scopedMatch) {
    validateFormulaName(formulaName);
    return {
      name: normalizeFormulaName(formulaName)
    };
  }

  // Formula name with optional version
  const atIndex = formulaName.lastIndexOf('@');

  if (atIndex === -1) {
    validateFormulaName(formulaName);
    return {
      name: normalizeFormulaName(formulaName)
    };
  }

  const name = formulaName.substring(0, atIndex);
  const version = formulaName.substring(atIndex + 1);

  if (!name || !version) {
    throw new ValidationError(ERROR_MESSAGES.INVALID_FORMULA_SYNTAX.replace('%s', formulaName));
  }

  validateFormulaName(name);

  return {
    name: normalizeFormulaName(name),
    version
  };
}

/**
 * Create formula.yml automatically in a directory without user prompts
 * Reuses init command logic but makes it non-interactive
 */
async function createFormulaYmlInDirectory(formulaDir: string, formulaName: string): Promise<{ fullPath: string; config: FormulaYml; isNewFormula: boolean }> {
  const cwd = process.cwd();
  
  // Ensure the target directory exists (including formulas subdirectory)
  await ensureLocalGroundZeroStructure(cwd);
  await ensureDir(formulaDir);
  
  // Create formula.yml in the formula directory (not the main .groundzero directory)
  const formulaYmlPath = join(formulaDir, FILE_PATTERNS.FORMULA_YML);
  
  // Create default formula config
  const formulaConfig: FormulaYml = {
    name: normalizeFormulaName(formulaName),
    version: DEFAULT_VERSION
  };
  
  // Create the formula.yml file
  await writeFormulaYml(formulaYmlPath, formulaConfig);
  console.log(`${LOG_PREFIXES.CREATED} ${formulaDir}`);
  console.log(`${LOG_PREFIXES.NAME} ${formulaConfig.name}`);
  console.log(`${LOG_PREFIXES.VERSION} ${formulaConfig.version}`);
  
  return {
    fullPath: formulaYmlPath,
    config: formulaConfig,
    isNewFormula: true
  };
}

/**
 * Get or create formula configuration in the specified directory
 * @param cwd - Current working directory
 * @param formulaDir - Directory where formula.yml should be located
 * @param formulaName - Name of the formula
 * @returns Formula configuration info
 */
async function getOrCreateFormulaConfig(cwd: string, formulaDir: string, formulaName: string): Promise<{ fullPath: string; config: FormulaYml; isNewFormula: boolean; isRootFormula: boolean }> {
  // Check if this is a root formula
  const rootFormulaPath = getLocalFormulaYmlPath(cwd);
  if (await exists(rootFormulaPath)) {
    try {
      const rootConfig = await parseFormulaYml(rootFormulaPath);
      if (areFormulaNamesEquivalent(rootConfig.name, formulaName)) {
        logger.debug('Detected root formula match');
        console.log(`✓ Found root formula ${rootConfig.name}@${rootConfig.version}`);
        return {
          fullPath: rootFormulaPath,
          config: rootConfig,
          isNewFormula: false,
          isRootFormula: true
        };
      }
    } catch (error) {
      // If root formula.yml is invalid, continue to sub-formula logic
      logger.warn(`Failed to parse root formula.yml: ${error}`);
    }
  }

  // Not a root formula - use sub-formula logic
  const formulaYmlPath = join(formulaDir, FILE_PATTERNS.FORMULA_YML);

  // Check if formula.yml already exists
  if (await exists(formulaYmlPath)) {
    logger.debug('Found existing formula.yml, parsing...');
    try {
      const formulaConfig = await parseFormulaYml(formulaYmlPath);
      console.log(`✓ Found existing formula ${formulaConfig.name}@${formulaConfig.version}`);

      return {
        fullPath: formulaYmlPath,
        config: formulaConfig,
        isNewFormula: false,
        isRootFormula: false
      };
    } catch (error) {
      throw new ValidationError(ERROR_MESSAGES.PARSE_FORMULA_FAILED.replace('%s', formulaYmlPath).replace('%s', String(error)));
    }
  } else {
    logger.debug('No formula.yml found, creating automatically...');
    const result = await createFormulaYmlInDirectory(formulaDir, formulaName);
    return {
      ...result,
      isRootFormula: false
    };
  }
}


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
  const { name, version: explicitVersion } = parseFormulaInputs(formulaName);

  logger.debug(`Saving formula with name: ${name}`, { explicitVersion, options });

  // Initialize formula environment
  await ensureRegistryDirectories();

  // Get formula configuration based on input pattern
  const formulaInfo = await getOrCreateFormulaYmlInfo(cwd, name, explicitVersion, versionType, options?.bump);
  const formulaConfig = formulaInfo.config;
  const isRootFormula = formulaInfo.isRootFormula;
  const formulaYmlPath = formulaInfo.fullPath;

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
  const discoveredFiles = await discoverFormulaFiles(formulaConfig.name);

  // Process discovered files and create formula files array
  const formulaFiles = await createFormulaFiles(formulaInfo, discoveredFiles);

  // Save formula to local registry
  const saveResult = await saveFormulaToRegistry(formulaInfo, formulaFiles);

  if (!saveResult.success) {
    return { success: false, error: saveResult.error || ERROR_MESSAGES.SAVE_FAILED };
  }

  // Sync universal files across detected platforms
  const syncResult = await postSavePlatformSync(cwd, formulaFiles);

  // Sync root files across detected platforms
  const rootSyncResult = await syncRootFiles(cwd, formulaFiles, formulaConfig.name);

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
  const totalCreated = syncResult.created.length + rootSyncResult.created.length;
  const totalUpdated = syncResult.updated.length + rootSyncResult.updated.length;

  if (totalCreated > 0) {
    const allCreated = [...syncResult.created, ...rootSyncResult.created].sort((a, b) => a.localeCompare(b));
    console.log(`✓ Platform sync created ${totalCreated} files:`);
    for (const createdFile of allCreated) {
      console.log(`   ├── ${createdFile}`);
    }
  }

  if (totalUpdated > 0) {
    const allUpdated = [...syncResult.updated, ...rootSyncResult.updated].sort((a, b) => a.localeCompare(b));
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
