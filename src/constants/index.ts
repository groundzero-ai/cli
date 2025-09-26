/**
 * Shared constants for the G0 CLI application
 * This file provides a single source of truth for all directory names,
 * file patterns, and other constants used throughout the application.
 */

export const PLATFORM_DIRS = {
  GROUNDZERO: '.groundzero',
  CURSOR: '.cursor',
  CLAUDE: '.claude',
  AI: 'ai'
} as const;

export const PLATFORM_NAMES = {
  CURSOR: 'cursor',
  CLAUDE: 'claude'
} as const;

export const FILE_PATTERNS = {
  MD_FILES: '.md',
  MDC_FILES: '.mdc',
  FORMULA_YML: 'formula.yml',
  HIDDEN_FORMULA_YML: '.formula.yml',
  GROUNDZERO_MDC: 'groundzero.mdc',
  GROUNDZERO_MD: 'groundzero.md'
} as const;

export const FORMULA_DIRS = {
  FORMULAS: 'formulas',
  CACHE: 'cache',
  RUNTIME: 'runtime'
} as const;

export const DEPENDENCY_ARRAYS = {
  FORMULAS: 'formulas',
  DEV_FORMULAS: 'dev-formulas'
} as const;

export const CONFLICT_RESOLUTION = {
  SKIPPED: 'skipped',
  KEPT: 'kept',
  OVERWRITTEN: 'overwritten'
} as const;

// Global files that should never be removed during uninstall (shared across all formulas)
export const GLOBAL_PLATFORM_FILES = {
  CURSOR_GROUNDZERO: `${PLATFORM_DIRS.CURSOR}/rules/${FILE_PATTERNS.GROUNDZERO_MDC}`,
  CLAUDE_GROUNDZERO: `${PLATFORM_DIRS.CLAUDE}/${FILE_PATTERNS.GROUNDZERO_MD}`
} as const;

// Type exports for better TypeScript integration
export type PlatformDir = typeof PLATFORM_DIRS[keyof typeof PLATFORM_DIRS];
export type PlatformName = typeof PLATFORM_NAMES[keyof typeof PLATFORM_NAMES];
export type FilePattern = typeof FILE_PATTERNS[keyof typeof FILE_PATTERNS];
export type FormulaDir = typeof FORMULA_DIRS[keyof typeof FORMULA_DIRS];
export type DependencyArray = typeof DEPENDENCY_ARRAYS[keyof typeof DEPENDENCY_ARRAYS];
export type ConflictResolution = typeof CONFLICT_RESOLUTION[keyof typeof CONFLICT_RESOLUTION];
