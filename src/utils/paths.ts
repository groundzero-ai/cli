import { join } from 'path';
import { PLATFORM_DIRS, FILE_PATTERNS, FORMULA_DIRS } from '../constants/index.js';

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

/**
 * Get the platform directory paths
 */
export function getPlatformDirs(cwd: string) {
  return {
    cursor: join(cwd, PLATFORM_DIRS.CURSOR),
    claude: join(cwd, PLATFORM_DIRS.CLAUDECODE),
    ai: join(cwd, PLATFORM_DIRS.AI),
    groundzero: join(cwd, PLATFORM_DIRS.GROUNDZERO)
  };
}
