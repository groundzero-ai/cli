/**
 * Shared constants for the G0 CLI application
 * This file provides a single source of truth for all directory names,
 * file patterns, and other constants used throughout the application.
 */

export const PLATFORMS = {
  // Special AI directory platform
  AI: 'ai',
  // AGENTS.md + MEMORIES platforms
  CODEXCLI: 'codexcli',
  OPENCODE: 'opencode',
  // Similar Root + Memories platforms
  CLAUDECODE: 'claudecode',
  QWENCODE: 'qwencode',
  GEMINICLI: 'geminicli',
  WARP: 'warp',
  // Rules Directory platforms
  CURSOR: 'cursor',
  CLINE: 'cline',
  ROO: 'roo',
  WINDSURF: 'windsurf',
  AUGMENT: 'augment',
  KIRO: 'kiro'
} as const;

// Human-friendly aliases mapped to platform ids
export const PLATFORM_ALIASES = {
  // CODEXCLI
  codex: PLATFORMS.CODEXCLI,
  // CLAUDECODE
  claude: PLATFORMS.CLAUDECODE,
  // GEMINICLI
  gemini: PLATFORMS.GEMINICLI,
  // QWENCODE
  qwen: PLATFORMS.QWENCODE
} as const;

export const PLATFORM_DIRS = {
  GROUNDZERO: '.groundzero',
  AI: 'ai',
  // AGENTS.md + MEMORIES platforms
  CODEXCLI: '.codex',
  OPENCODE: '.opencode',
  // Similar Root + Memories platforms
  CLAUDECODE: '.claude',
  QWENCODE: '.qwen',
  GEMINICLI: '.gemini',
  WARP: '.warp',
  // Rules Directory platforms
  CURSOR: '.cursor',
  CLINE: '.clinerules',
  ROO: '.roo',
  WINDSURF: '.windsurf',
  AUGMENT: '.augment',
  KIRO: '.kiro'
} as const;

export const FILE_PATTERNS = {
  MD_FILES: '.md',
  MDC_FILES: '.mdc',
  FORMULA_YML: 'formula.yml',
  README_MD: 'README.md',
  GROUNDZERO_MDC: 'groundzero.mdc',
  GROUNDZERO_MD: 'groundzero.md',
  // Platform-specific root files
  AGENTS_MD: 'AGENTS.md',
  CLAUDE_MD: 'CLAUDE.md',
  QWEN_MD: 'QWEN.md',
  GEMINI_MD: 'GEMINI.md',
  WARP_MD: 'WARP.md'
} as const;

// Universal subdirectory names used across all platforms
export const UNIVERSAL_SUBDIRS = {
  RULES: 'rules',
  COMMANDS: 'commands',
  AGENTS: 'agents'
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
  // Rules Directory platforms
  CURSOR_GROUNDZERO: `${PLATFORM_DIRS.CURSOR}/rules/${FILE_PATTERNS.GROUNDZERO_MDC}`,
  CLINE_GROUNDZERO: `${PLATFORM_DIRS.CLINE}/${FILE_PATTERNS.GROUNDZERO_MD}`,
  ROO_GROUNDZERO: `${PLATFORM_DIRS.ROO}/rules/${FILE_PATTERNS.GROUNDZERO_MD}`,
  WINDSURF_GROUNDZERO: `${PLATFORM_DIRS.WINDSURF}/rules/${FILE_PATTERNS.GROUNDZERO_MD}`,
  AUGMENT_GROUNDZERO: `${PLATFORM_DIRS.AUGMENT}/rules/${FILE_PATTERNS.GROUNDZERO_MD}`,
  KIRO_GROUNDZERO: `${PLATFORM_DIRS.KIRO}/steering/${FILE_PATTERNS.GROUNDZERO_MD}`,
  // Root + Memories platforms
  CLAUDECODE_GROUNDZERO: `${PLATFORM_DIRS.CLAUDECODE}/${FILE_PATTERNS.GROUNDZERO_MD}`,
  QWENCODE_GROUNDZERO: `${PLATFORM_DIRS.QWENCODE}/${FILE_PATTERNS.GROUNDZERO_MD}`,
  GEMINICLI_GROUNDZERO: `${PLATFORM_DIRS.GEMINICLI}/${FILE_PATTERNS.GROUNDZERO_MD}`,
  WARP_GROUNDZERO: `${PLATFORM_DIRS.WARP}/${FILE_PATTERNS.GROUNDZERO_MD}`,
  // AGENTS.md + MEMORIES platforms
  CODEXCLI_GROUNDZERO: `${PLATFORM_DIRS.CODEXCLI}/${FILE_PATTERNS.GROUNDZERO_MD}`,
  OPENCODE_GROUNDZERO: `${PLATFORM_DIRS.OPENCODE}/${FILE_PATTERNS.GROUNDZERO_MD}`
} as const;

// Type exports for better TypeScript integration
export type Platform = typeof PLATFORMS[keyof typeof PLATFORMS];
export type PlatformDir = typeof PLATFORM_DIRS[keyof typeof PLATFORM_DIRS];
export type FilePattern = typeof FILE_PATTERNS[keyof typeof FILE_PATTERNS];
export type UniversalSubdir = typeof UNIVERSAL_SUBDIRS[keyof typeof UNIVERSAL_SUBDIRS];
export type FormulaDir = typeof FORMULA_DIRS[keyof typeof FORMULA_DIRS];
export type DependencyArray = typeof DEPENDENCY_ARRAYS[keyof typeof DEPENDENCY_ARRAYS];
export type ConflictResolution = typeof CONFLICT_RESOLUTION[keyof typeof CONFLICT_RESOLUTION];

// Alias for backward compatibility
export const PLATFORM_NAMES = PLATFORMS;
