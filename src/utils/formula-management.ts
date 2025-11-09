import { basename, join, relative } from 'path';
import { FormulaYml, FormulaDependency } from '../types/index.js';
import { parseFormulaYml, writeFormulaYml } from './formula-yml.js';
import { exists, ensureDir, writeTextFile, walkFiles, remove } from './fs.js';
import { logger } from './logger.js';
import { getLocalGroundZeroDir, getLocalFormulaYmlPath, getLocalFormulasDir, getLocalFormulaDir } from './paths.js';
import { DEPENDENCY_ARRAYS, FILE_PATTERNS } from '../constants/index.js';
import { createCaretRange } from './version-ranges.js';
import { extractBaseVersion } from './version-generator.js';
import { normalizeFormulaName, areFormulaNamesEquivalent } from './formula-name.js';
import { formulaManager } from '../core/formula.js';
import { FORMULA_INDEX_FILENAME } from './formula-index-yml.js';

/**
 * Ensure local GroundZero directory structure exists
 * Shared utility for both install and save commands
 */
export async function ensureLocalGroundZeroStructure(cwd: string): Promise<void> {
  const groundzeroDir = getLocalGroundZeroDir(cwd);
  const formulasDir = getLocalFormulasDir(cwd);
  
  await Promise.all([
    ensureDir(groundzeroDir),
    ensureDir(formulasDir)
  ]);
}

/**
 * Create a basic formula.yml file if it doesn't exist
 * Shared utility for both install and save commands
 * @param force - If true, overwrite existing formula.yml
 * @returns the formula.yml if it was created, null if it already existed and force=false
 */
export async function createBasicFormulaYml(cwd: string, force: boolean = false): Promise<FormulaYml | null> {
  await ensureLocalGroundZeroStructure(cwd);

  const formulaYmlPath = getLocalFormulaYmlPath(cwd);
  const projectName = basename(cwd);
  const basicFormulaYml: FormulaYml = {
    name: projectName,
    version: '0.1.0',
    formulas: [],
    'dev-formulas': []
  };

  if (await exists(formulaYmlPath)) {
    if (!force) {
      return null; // formula.yml already exists, no need to create
    }
    await writeFormulaYml(formulaYmlPath, basicFormulaYml);
    logger.info(`Overwrote basic formula.yml with name: ${projectName}`);
    console.log(`📋 Overwrote basic formula.yml in .groundzero/ with name: ${projectName}`);
    return basicFormulaYml;
  }

  await writeFormulaYml(formulaYmlPath, basicFormulaYml);
  logger.info(`Initialized workspace formula.yml`);
  console.log(`📋 Initialized workspace formula.yml in .groundzero/`);
  return basicFormulaYml;
}

/**
 * Add a formula dependency to formula.yml with smart placement logic
 * Shared utility for both install and save commands
 */
export async function addFormulaToYml(
  cwd: string,
  formulaName: string,
  formulaVersion: string,
  isDev: boolean = false,
  originalVersion?: string, // The original version/range that was requested
  silent: boolean = false
): Promise<void> {
  const formulaYmlPath = getLocalFormulaYmlPath(cwd);
  
  if (!(await exists(formulaYmlPath))) {
    return; // If no formula.yml exists, ignore this step
  }
  
  const config = await parseFormulaYml(formulaYmlPath);
  
  // Determine the version to write to formula.yml
  let versionToWrite: string;
  
  if (originalVersion) {
    // If we have the original version/range, use it as-is
    versionToWrite = originalVersion;
  } else {
    // For save command, strip prerelease versioning and create caret range
    const baseVersion = extractBaseVersion(formulaVersion);
    versionToWrite = createCaretRange(baseVersion);
  }
  
  const dependency: FormulaDependency = {
    name: normalizeFormulaName(formulaName),
    version: versionToWrite
  };
  
  // Find current location and determine target location
  const currentLocation = await findFormulaLocation(cwd, formulaName);
  
  let targetArray: 'formulas' | 'dev-formulas';
  if (currentLocation === DEPENDENCY_ARRAYS.DEV_FORMULAS && !isDev) {
    targetArray = DEPENDENCY_ARRAYS.DEV_FORMULAS;
    logger.info(`Keeping formula in dev-formulas: ${formulaName}@${formulaVersion}`);
  } else if (currentLocation === DEPENDENCY_ARRAYS.FORMULAS && isDev) {
    targetArray = DEPENDENCY_ARRAYS.DEV_FORMULAS;
    logger.info(`Moving formula from formulas to dev-formulas: ${formulaName}@${formulaVersion}`);
  } else {
    targetArray = isDev ? DEPENDENCY_ARRAYS.DEV_FORMULAS : DEPENDENCY_ARRAYS.FORMULAS;
  }
  
  // Initialize arrays if they don't exist
  if (!config.formulas) config.formulas = [];
  if (!config[DEPENDENCY_ARRAYS.DEV_FORMULAS]) config[DEPENDENCY_ARRAYS.DEV_FORMULAS] = [];
  
  // Remove from current location if moving between arrays
  if (currentLocation && currentLocation !== targetArray) {
    const currentArray = config[currentLocation]!;
    const currentIndex = currentArray.findIndex(dep => areFormulaNamesEquivalent(dep.name, formulaName));
    if (currentIndex >= 0) {
      currentArray.splice(currentIndex, 1);
    }
  }
  
  // Update or add dependency
  const targetArrayRef = config[targetArray]!;
  const existingIndex = targetArrayRef.findIndex(dep => areFormulaNamesEquivalent(dep.name, formulaName));
  
  if (existingIndex >= 0) {
    targetArrayRef[existingIndex] = dependency;
    if (!silent) {
      logger.info(`Updated existing formula dependency: ${formulaName}@${formulaVersion}`);
      console.log(`✓ Updated ${formulaName}@${formulaVersion} in main formula.yml`);
    }
  } else {
    targetArrayRef.push(dependency);
    if (!silent) {
      logger.info(`Added new formula dependency: ${formulaName}@${formulaVersion}`);
      console.log(`✓ Added ${formulaName}@${formulaVersion} to main formula.yml`);
    }
  }
  
  await writeFormulaYml(formulaYmlPath, config);
}

/**
 * Copy the full formula directory from the local registry into the project structure
 * Removes all existing files except formula.index.yml before writing new files
 */
export async function writeLocalFormulaFromRegistry(
  cwd: string,
  formulaName: string,
  version: string
): Promise<void> {
  const formula = await formulaManager.loadFormula(formulaName, version);
  const localFormulaDir = getLocalFormulaDir(cwd, formulaName);

  await ensureDir(localFormulaDir);

  // Build set of files that should exist after installation
  const filesToKeep = new Set<string>(
    formula.files.map(file => file.path)
  );
  // Always preserve formula.index.yml
  filesToKeep.add(FORMULA_INDEX_FILENAME);

  // List all existing files in the directory
  const existingFiles: string[] = [];
  if (await exists(localFormulaDir)) {
    for await (const filePath of walkFiles(localFormulaDir)) {
      const relPath = relative(localFormulaDir, filePath);
      existingFiles.push(relPath);
    }
  }

  // Remove files that are no longer in the formula (except formula.index.yml)
  const filesToRemove = existingFiles.filter(file => !filesToKeep.has(file));
  await Promise.all(
    filesToRemove.map(async (file) => {
      const filePath = join(localFormulaDir, file);
      try {
        await remove(filePath);
        logger.debug(`Removed residual file: ${filePath}`);
      } catch (error) {
        logger.warn(`Failed to remove residual file ${filePath}: ${error}`);
      }
    })
  );

  // Write all files from the formula
  await Promise.all(
    formula.files.map(async (file) => {
      const targetPath = join(localFormulaDir, file.path);
      const encoding = (file.encoding ?? 'utf8') as BufferEncoding;
      await writeTextFile(targetPath, file.content, encoding);
    })
  );
}

/**
 * Find formula location in formula.yml
 * Helper function for addFormulaToYml
 */
async function findFormulaLocation(
  cwd: string,
  formulaName: string
): Promise<'formulas' | 'dev-formulas' | null> {
  const formulaYmlPath = getLocalFormulaYmlPath(cwd);
  
  if (!(await exists(formulaYmlPath))) {
    return null;
  }
  
  try {
    const config = await parseFormulaYml(formulaYmlPath);
    
    // Check in formulas array
    if (config.formulas?.some(dep => areFormulaNamesEquivalent(dep.name, formulaName))) {
      return DEPENDENCY_ARRAYS.FORMULAS;
    }

    // Check in dev-formulas array
    if (config[DEPENDENCY_ARRAYS.DEV_FORMULAS]?.some(dep => areFormulaNamesEquivalent(dep.name, formulaName))) {
      return DEPENDENCY_ARRAYS.DEV_FORMULAS;
    }
    
    return null;
  } catch (error) {
    logger.warn(`Failed to parse formula.yml: ${error}`);
    return null;
  }
}
