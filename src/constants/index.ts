/**
 * Shared constants for the OpenPackage CLI application
 * This file provides a single source of truth for all directory names,
 * file patterns, and other constants used throughout the application.
 */

export const DIR_PATTERNS = {
  OPENPACKAGE: '.openpackage'
} as const;

export const FILE_PATTERNS = {
  MD_FILES: '.md',
  MDC_FILES: '.mdc',
  TOML_FILES: '.toml',
  PACKAGE_YML: 'package.yml',
  PACKAGE_INDEX_YML: 'package.index.yml',
  README_MD: 'README.md',
  // Platform-specific root files
  AGENTS_MD: 'AGENTS.md',
  CLAUDE_MD: 'CLAUDE.md',
  GEMINI_MD: 'GEMINI.md',
  QWEN_MD: 'QWEN.md',
  WARP_MD: 'WARP.md',
  // File patterns arrays
  MARKDOWN_FILES: ['.md', '.mdc'],
  YML_FILE: '.yml',
} as const;

// Universal subdirectory names used across all platforms
export const UNIVERSAL_SUBDIRS = {
  RULES: 'rules',
  COMMANDS: 'commands',
  AGENTS: 'agents',
  SKILLS: 'skills'
} as const;

export const OPENPACKAGE_DIRS = {
  REGISTRY: 'registry',
  PACKAGES: 'packages',
  CACHE: 'cache',
  RUNTIME: 'runtime'
} as const;

/**
 * Canonical paths within a package (relative to the package root).
 */
export const PACKAGE_PATHS = {
  /**
   * The canonical location of the package manifest within a package:
   * <package-root>/.openpackage/package.yml
   */
  MANIFEST_RELATIVE: `${DIR_PATTERNS.OPENPACKAGE}/${FILE_PATTERNS.PACKAGE_YML}`,
  /**
   * The canonical location of the package index file within a package:
   * <package-root>/.openpackage/package.index.yml
   */
  INDEX_RELATIVE: `${DIR_PATTERNS.OPENPACKAGE}/${FILE_PATTERNS.PACKAGE_INDEX_YML}`,
} as const;

export const DEPENDENCY_ARRAYS = {
  PACKAGES: 'packages',
  DEV_PACKAGES: 'dev-packages'
} as const;

export const CONFLICT_RESOLUTION = {
  SKIPPED: 'skipped',
  KEPT: 'kept',
  OVERWRITTEN: 'overwritten'
} as const;

export type FilePattern = typeof FILE_PATTERNS[keyof typeof FILE_PATTERNS];
export type UniversalSubdir = typeof UNIVERSAL_SUBDIRS[keyof typeof UNIVERSAL_SUBDIRS];
export type OpenPackageDir = typeof OPENPACKAGE_DIRS[keyof typeof OPENPACKAGE_DIRS];
export type DependencyArray = typeof DEPENDENCY_ARRAYS[keyof typeof DEPENDENCY_ARRAYS];
export type ConflictResolution = typeof CONFLICT_RESOLUTION[keyof typeof CONFLICT_RESOLUTION];
