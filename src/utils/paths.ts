import { join } from 'path';
import { PLATFORM_DIRS, FILE_PATTERNS, FORMULA_DIRS } from '../constants/index.js';
import { exists } from './fs.js';
import { areFormulaNamesEquivalent, SCOPED_FORMULA_REGEX } from './formula-name.js';
import { parseFormulaYml } from './formula-yml.js';

/**
 * Path utility functions for consistent file and directory path handling
 * across the OpenPackage CLI application.
 */

/**
 * Get the path to the local formula.yml file
 */
export function getLocalFormulaYmlPath(cwd: string): string {
  return join(cwd, PLATFORM_DIRS.OPENPACKAGE, FILE_PATTERNS.FORMULA_YML);
}

/**
 * Check if a formula name matches the root formula in .openpackage/formula.yml
 */
export async function isRootFormula(cwd: string, formulaName: string): Promise<boolean> {
  const rootFormulaYmlPath = getLocalFormulaYmlPath(cwd);
  if (!(await exists(rootFormulaYmlPath))) {
    return false;
  }
  
  try {
    const config = await parseFormulaYml(rootFormulaYmlPath);
    return areFormulaNamesEquivalent(config.name, formulaName);
  } catch (error) {
    return false;
  }
}

/**
 * Get the local OpenPackage directory path
 */
export function getLocalOpenPackageDir(cwd: string): string {
  return join(cwd, PLATFORM_DIRS.OPENPACKAGE);
}

/**
 * Get the local formulas directory path
 */
export function getLocalFormulasDir(cwd: string): string {
  return join(cwd, PLATFORM_DIRS.OPENPACKAGE, FORMULA_DIRS.FORMULAS);
}

/**
 * Get the local formula directory path for a specific formula
 * Handles scoped formulas with nested directory structure (@scope/name -> @scope/name/)
 */
export function getLocalFormulaDir(cwd: string, formulaName: string): string {
  const scopedMatch = formulaName.match(SCOPED_FORMULA_REGEX);
  if (scopedMatch) {
    const [, scope, localName] = scopedMatch;
    return join(cwd, PLATFORM_DIRS.OPENPACKAGE, FORMULA_DIRS.FORMULAS, '@' + scope, localName);
  }
  return join(cwd, PLATFORM_DIRS.OPENPACKAGE, FORMULA_DIRS.FORMULAS, formulaName);
}

/**
 * Get the AI directory path
 */
export function getAIDir(cwd: string): string {
  return join(cwd, PLATFORM_DIRS.AI);
}

