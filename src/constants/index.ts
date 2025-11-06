/**
 * Shared constants for the G0 CLI application
 * This file provides a single source of truth for all directory names,
 * file patterns, and other constants used throughout the application.
 */

export const PLATFORMS = {
  AUGMENT: 'augment',
  CLAUDE: 'claude',
  CODEX: 'codex',
  CURSOR: 'cursor',
  FACTORY: 'factory',
  GEMINI: 'gemini',
  KILO: 'kilo',
  KIRO: 'kiro',
  OPENCODE: 'opencode',
  QWEN: 'qwen',
  ROO: 'roo',
  WARP: 'warp',
  WINDSURF: 'windsurf',
} as const;

export const PLATFORM_AI = 'ai';

// Human-friendly aliases mapped to platform ids
export const PLATFORM_ALIASES = {
  // CODEXCLI
  codexcli: PLATFORMS.CODEX,
  // CLAUDECODE
  claudecode: PLATFORMS.CLAUDE,
  // GEMINICLI
  geminicli: PLATFORMS.GEMINI,
  // KILO
  kilocode: PLATFORMS.KILO,
  // QWENCODE
  qwencode: PLATFORMS.QWEN
} as const;

export const PLATFORM_DIRS = {
  GROUNDZERO: '.groundzero',
  AI: 'ai',

  AUGMENT: '.augment',
  CLAUDE: '.claude',
  CODEX: '.codex',
  CURSOR: '.cursor',
  FACTORY: '.factory',
  GEMINI: '.gemini',
  KILO: '.kilocode',
  KIRO: '.kiro',
  OPENCODE: '.opencode',
  QWEN: '.qwen',
  ROO: '.roo',
  WARP: '.warp',
  WINDSURF: '.windsurf',
} as const;

export const FILE_PATTERNS = {
  MD_FILES: '.md',
  MDC_FILES: '.mdc',
  TOML_FILES: '.toml',
  FORMULA_YML: 'formula.yml',
  INDEX_YML: 'index.yml',
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

// Type exports for better TypeScript integration
export type Platform = typeof PLATFORMS[keyof typeof PLATFORMS];
export type PlatformDir = typeof PLATFORM_DIRS[keyof typeof PLATFORM_DIRS];
export type FilePattern = typeof FILE_PATTERNS[keyof typeof FILE_PATTERNS];
export type UniversalSubdir = typeof UNIVERSAL_SUBDIRS[keyof typeof UNIVERSAL_SUBDIRS];
export type FormulaDir = typeof FORMULA_DIRS[keyof typeof FORMULA_DIRS];
export type DependencyArray = typeof DEPENDENCY_ARRAYS[keyof typeof DEPENDENCY_ARRAYS];
export type ConflictResolution = typeof CONFLICT_RESOLUTION[keyof typeof CONFLICT_RESOLUTION];
