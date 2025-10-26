import { basename, join } from 'path';
import { FormulaYml, FormulaDependency } from '../types/index.js';
import { parseFormulaYml, writeFormulaYml } from './formula-yml.js';
import { exists, ensureDir, writeTextFile } from './fs.js';
import { logger } from './logger.js';
import { getLocalGroundZeroDir, getLocalFormulaYmlPath, getLocalFormulasDir } from './paths.js';
import { DEPENDENCY_ARRAYS, FILE_PATTERNS } from '../constants/index.js';
import { createCaretRange } from './version-ranges.js';
import { extractBaseVersion } from './version-generator.js';
import { normalizeFormulaName, areFormulaNamesEquivalent } from './formula-name.js';

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
 * @returns the formula.yml if it was created, null if it already existed
 */
export async function createBasicFormulaYml(cwd: string): Promise<FormulaYml | null> {
  await ensureLocalGroundZeroStructure(cwd);
  
  const formulaYmlPath = getLocalFormulaYmlPath(cwd);
  
  if (await exists(formulaYmlPath)) {
    return null; // formula.yml already exists, no need to create
  }
  
  const projectName = basename(cwd);
  const basicFormulaYml: FormulaYml = {
    name: projectName,
    version: '0.1.0',
    formulas: [],
    'dev-formulas': []
  };
  
  await writeFormulaYml(formulaYmlPath, basicFormulaYml);
  logger.info(`Created basic formula.yml with name: ${projectName}`);
  console.log(`📋 Created basic formula.yml in .groundzero/ with name: ${projectName}`);
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
 * Write formula metadata and optional README.md to local project structure
 * Shared utility for install command
 */
export async function writeLocalFormulaMetadata(
  cwd: string,
  formulaName: string,
  metadata: FormulaYml,
  readmeContent?: string
): Promise<void> {
  const normalizedFormulaName = normalizeFormulaName(formulaName);
  const localFormulaDir = join(getLocalFormulasDir(cwd), normalizedFormulaName);
  const localFormulaYmlPath = join(localFormulaDir, FILE_PATTERNS.FORMULA_YML);
  await ensureDir(localFormulaDir);
  await writeFormulaYml(localFormulaYmlPath, metadata);
  if (readmeContent) {
    await writeTextFile(join(localFormulaDir, FILE_PATTERNS.README_MD), readmeContent);
  }
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
