import { join } from 'path';
import { PLATFORM_DIRS, FILE_PATTERNS, FORMULA_DIRS } from '../constants/index.js';
import { exists } from './fs.js';
import { areFormulaNamesEquivalent } from './formula-name.js';

/**
 * Path utility functions for consistent file and directory path handling
 * across the G0 CLI application.
 */

/**
 * Get the path to the local formula.yml file
 */
export function getLocalFormulaYmlPath(cwd: string): string {
  return join(cwd, PLATFORM_DIRS.GROUNDZERO, FILE_PATTERNS.FORMULA_YML);
}

/**
 * Check if a formula name matches the root formula in .groundzero/formula.yml
 */
export async function isRootFormula(cwd: string, formulaName: string): Promise<boolean> {
  const rootFormulaYmlPath = getLocalFormulaYmlPath(cwd);
  if (!(await exists(rootFormulaYmlPath))) {
    return false;
  }
  
  try {
    const { parseFormulaYml } = await import('./formula-yml.js');
    const config = await parseFormulaYml(rootFormulaYmlPath);
    return areFormulaNamesEquivalent(config.name, formulaName);
  } catch (error) {
    return false;
  }
}

/**
 * Get the path to store local formula metadata
 */
export function getLocalFormulaMetadataPath(cwd: string, formulaName: string): string {
  return join(cwd, PLATFORM_DIRS.GROUNDZERO, FORMULA_DIRS.FORMULAS, formulaName, FILE_PATTERNS.FORMULA_YML);
}

/**
 * Get the local GroundZero directory path
 */
export function getLocalGroundZeroDir(cwd: string): string {
  return join(cwd, PLATFORM_DIRS.GROUNDZERO);
}

/**
 * Get the local formulas directory path
 */
export function getLocalFormulasDir(cwd: string): string {
  return join(cwd, PLATFORM_DIRS.GROUNDZERO, FORMULA_DIRS.FORMULAS);
}

/**
 * Get the local formula directory path for a specific formula
 */
 export function getLocalFormulaDir(cwd: string, formulaName: string): string {
  return join(cwd, PLATFORM_DIRS.GROUNDZERO, FORMULA_DIRS.FORMULAS, formulaName);
}

/**
 * Get the AI directory path
 */
export function getAIDir(cwd: string): string {
  return join(cwd, PLATFORM_DIRS.AI);
}

