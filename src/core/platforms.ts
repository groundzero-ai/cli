/**
 * Platform Management Module
 * Centralized platform definitions, directory mappings, and file patterns
 * for all 13 supported AI coding platforms
 */

import { join } from 'path';
import { exists, ensureDir, listFiles } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { PLATFORMS, PLATFORM_DIRS, PLATFORM_SUBDIRS, FILE_PATTERNS, type Platform } from '../constants/index.js';

// Platform Categories
export const PLATFORM_CATEGORIES = {
  AGENTS_MEMORIES: 'agents-memories',
  ROOT_MEMORIES: 'root-memories', 
  RULES_DIRECTORY: 'rules-directory'
} as const;

// All platforms combined
export const ALL_PLATFORMS = Object.values(PLATFORMS) as readonly Platform[];

// Platform definitions with directory mappings and file patterns
export const PLATFORM_DEFINITIONS: Record<PlatformName, PlatformDefinition> = {
  // AGENTS.md + MEMORIES platforms
  [PLATFORMS.CODEXCLI]: {
    name: PLATFORMS.CODEXCLI,
    category: PLATFORM_CATEGORIES.AGENTS_MEMORIES,
    rootDir: PLATFORM_DIRS.CODEXCLI,
    rootFile: FILE_PATTERNS.AGENTS_MD,
    rulesDir: `${PLATFORM_DIRS.CODEXCLI}/${PLATFORM_SUBDIRS.MEMORIES}`,
    commandsDir: `${PLATFORM_DIRS.CODEXCLI}/${PLATFORM_SUBDIRS.COMMANDS}`,
    agentsDir: `${PLATFORM_DIRS.CODEXCLI}/${PLATFORM_SUBDIRS.AGENTS}`,
    rulesDirFilePatterns: [FILE_PATTERNS.MD_FILES] as const,
    description: 'OpenAI Codex CLI - AGENTS.md + .codex/memories/ + .codex/commands + .codex/agents'
  },
  [PLATFORMS.OPENCODE]: {
    name: PLATFORMS.OPENCODE,
    category: PLATFORM_CATEGORIES.AGENTS_MEMORIES,
    rootDir: PLATFORM_DIRS.OPENCODE,
    rootFile: FILE_PATTERNS.AGENTS_MD,
    rulesDir: `${PLATFORM_DIRS.OPENCODE}/${PLATFORM_SUBDIRS.MEMORIES}`,
    commandsDir: `${PLATFORM_DIRS.OPENCODE}/${PLATFORM_SUBDIRS.COMMANDS}`,
    agentsDir: `${PLATFORM_DIRS.OPENCODE}/${PLATFORM_SUBDIRS.AGENTS}`,
    rulesDirFilePatterns: [FILE_PATTERNS.MD_FILES] as const,
    description: 'OpenCode - AGENTS.md + .opencode/memories/ + .opencode/commands + .opencode/agents'
  },
  
  // Similar Root + Memories platforms
  [PLATFORMS.CLAUDECODE]: {
    name: PLATFORMS.CLAUDECODE,
    category: PLATFORM_CATEGORIES.ROOT_MEMORIES,
    rootDir: PLATFORM_DIRS.CLAUDECODE,
    rootFile: FILE_PATTERNS.CLAUDE_MD,
    rulesDir: `${PLATFORM_DIRS.CLAUDECODE}/${PLATFORM_SUBDIRS.MEMORIES}`,
    commandsDir: `${PLATFORM_DIRS.CLAUDECODE}/${PLATFORM_SUBDIRS.COMMANDS}`,
    agentsDir: `${PLATFORM_DIRS.CLAUDECODE}/${PLATFORM_SUBDIRS.AGENTS}`,
    rulesDirFilePatterns: [FILE_PATTERNS.MD_FILES] as const,
    description: 'Claude Code - CLAUDE.md + .claude/memories/ + .claude/commands + .claude/agents'
  },
  [PLATFORMS.QWENCODE]: {
    name: PLATFORMS.QWENCODE,
    category: PLATFORM_CATEGORIES.ROOT_MEMORIES,
    rootDir: PLATFORM_DIRS.QWENCODE,
    rootFile: FILE_PATTERNS.QWEN_MD,
    rulesDir: `${PLATFORM_DIRS.QWENCODE}/${PLATFORM_SUBDIRS.MEMORIES}`,
    agentsDir: `${PLATFORM_DIRS.QWENCODE}/${PLATFORM_SUBDIRS.AGENTS}`,
    rulesDirFilePatterns: [FILE_PATTERNS.MD_FILES] as const,
    description: 'Qwen Code - QWEN.md + .qwen/memories/ + .qwen/agents'
  },
  [PLATFORMS.GEMINICLI]: {
    name: PLATFORMS.GEMINICLI,
    category: PLATFORM_CATEGORIES.ROOT_MEMORIES,
    rootDir: PLATFORM_DIRS.GEMINICLI,
    rootFile: FILE_PATTERNS.GEMINI_MD,
    rulesDir: `${PLATFORM_DIRS.GEMINICLI}/${PLATFORM_SUBDIRS.MEMORIES}`,
    commandsDir: `${PLATFORM_DIRS.GEMINICLI}/${PLATFORM_SUBDIRS.COMMANDS}`,
    rulesDirFilePatterns: [FILE_PATTERNS.MD_FILES] as const,
    description: 'Gemini CLI - GEMINI.md + .gemini/memories/ + .gemini/commands (.toml files)'
  },
  [PLATFORMS.WARP]: {
    name: PLATFORMS.WARP,
    category: PLATFORM_CATEGORIES.ROOT_MEMORIES,
    rootDir: PLATFORM_DIRS.WARP,
    rootFile: FILE_PATTERNS.WARP_MD,
    rulesDir: `${PLATFORM_DIRS.WARP}/${PLATFORM_SUBDIRS.MEMORIES}`,
    rulesDirFilePatterns: [FILE_PATTERNS.MD_FILES] as const,
    description: 'Warp - WARP.md + .warp/memories/'
  },
  
  // Rules Directory platforms
  [PLATFORMS.CURSOR]: {
    name: PLATFORMS.CURSOR,
    category: PLATFORM_CATEGORIES.RULES_DIRECTORY,
    rootDir: PLATFORM_DIRS.CURSOR,
    rulesDir: `${PLATFORM_DIRS.CURSOR}/${PLATFORM_SUBDIRS.RULES}`,
    commandsDir: `${PLATFORM_DIRS.CURSOR}/${PLATFORM_SUBDIRS.COMMANDS}`,
    rulesDirFilePatterns: [FILE_PATTERNS.MDC_FILES] as const,
    description: 'Cursor - .cursor/rules/ (*.mdc files) + .cursor/commands'
  },
  [PLATFORMS.CLINE]: {
    name: PLATFORMS.CLINE,
    category: PLATFORM_CATEGORIES.RULES_DIRECTORY,
    rootDir: PLATFORM_DIRS.CLINE,
    rulesDir: PLATFORM_DIRS.CLINE,
    rulesDirFilePatterns: [FILE_PATTERNS.MD_FILES] as const,
    description: 'Cline - .clinerules/ (*.md files)'
  },
  [PLATFORMS.ROO]: {
    name: PLATFORMS.ROO,
    category: PLATFORM_CATEGORIES.RULES_DIRECTORY,
    rootDir: PLATFORM_DIRS.ROO,
    rulesDir: `${PLATFORM_DIRS.ROO}/${PLATFORM_SUBDIRS.RULES}`,
    commandsDir: `${PLATFORM_DIRS.ROO}/${PLATFORM_SUBDIRS.COMMANDS}`,
    rulesDirFilePatterns: [FILE_PATTERNS.MD_FILES] as const,
    description: 'Roo Code - .roo/rules/ (*.md files) + .roo/commands'
  },
  [PLATFORMS.WINDSURF]: {
    name: PLATFORMS.WINDSURF,
    category: PLATFORM_CATEGORIES.RULES_DIRECTORY,
    rootDir: PLATFORM_DIRS.WINDSURF,
    rulesDir: `${PLATFORM_DIRS.WINDSURF}/${PLATFORM_SUBDIRS.RULES}`,
    rulesDirFilePatterns: [FILE_PATTERNS.MD_FILES] as const,
    description: 'Windsurf - .windsurf/rules/ (*.md files)'
  },
  [PLATFORMS.AUGMENT]: {
    name: PLATFORMS.AUGMENT,
    category: PLATFORM_CATEGORIES.RULES_DIRECTORY,
    rootDir: PLATFORM_DIRS.AUGMENT,
    rulesDir: `${PLATFORM_DIRS.AUGMENT}/${PLATFORM_SUBDIRS.RULES}`,
    commandsDir: `${PLATFORM_DIRS.AUGMENT}/${PLATFORM_SUBDIRS.COMMANDS}`,
    rulesDirFilePatterns: [FILE_PATTERNS.MD_FILES] as const,
    description: 'AugmentCode - .augment/rules/ (*.md files) + .augment/commands'
  },
  [PLATFORMS.KIRO]: {
    name: PLATFORMS.KIRO,
    category: PLATFORM_CATEGORIES.RULES_DIRECTORY,
    rootDir: PLATFORM_DIRS.KIRO,
    rulesDir: `${PLATFORM_DIRS.KIRO}/${PLATFORM_SUBDIRS.STEERING}`,
    rulesDirFilePatterns: [FILE_PATTERNS.MD_FILES] as const,
    description: 'Kiro IDE - .kiro/steering/ (*.md files)'
  }
} as const;

// Type definitions
export type PlatformName = Platform;
export type PlatformCategory = typeof PLATFORM_CATEGORIES[keyof typeof PLATFORM_CATEGORIES];

export interface PlatformDefinition {
  name: PlatformName;
  category: PlatformCategory;
  rootDir: string;
  rootFile?: string;
  rulesDir: string;
  commandsDir?: string;
  agentsDir?: string;
  rulesDirFilePatterns: readonly string[];
  description: string;
}

export interface PlatformDetectionResult {
  name: PlatformName;
  detected: boolean;
}

export interface PlatformDirectoryPaths {
  [platformName: string]: {
    rulesDir: string;
    rootFile?: string;
    commandsDir?: string;
    agentsDir?: string;
  };
}

/**
 * Get platform definition by name
 */
export function getPlatformDefinition(name: PlatformName): PlatformDefinition {
  return PLATFORM_DEFINITIONS[name];
}

/**
 * Get all platforms by category
 */
export function getPlatformsByCategory(category: PlatformCategory): PlatformName[] {
  return ALL_PLATFORMS.filter(platform => 
    PLATFORM_DEFINITIONS[platform].category === category
  );
}

/**
 * Get platform directory paths for a given working directory
 */
export function getPlatformDirectoryPaths(cwd: string): PlatformDirectoryPaths {
  const paths: PlatformDirectoryPaths = {};
  
  for (const platform of ALL_PLATFORMS) {
    const definition = PLATFORM_DEFINITIONS[platform];
    paths[platform] = {
      rulesDir: join(cwd, definition.rulesDir)
    };
    
    if ('rootFile' in definition && definition.rootFile) {
      paths[platform].rootFile = join(cwd, definition.rootFile);
    }
    
    if ('commandsDir' in definition && definition.commandsDir) {
      paths[platform].commandsDir = join(cwd, definition.commandsDir);
    }
    
    if ('agentsDir' in definition && definition.agentsDir) {
      paths[platform].agentsDir = join(cwd, definition.agentsDir);
    }
  }
  
  return paths;
}

/**
 * Detect all platforms present in a directory
 */
export async function detectAllPlatforms(cwd: string): Promise<PlatformDetectionResult[]> {
  // Check all platforms in parallel
  const detectionPromises = ALL_PLATFORMS.map(async (platform) => {
    const definition = PLATFORM_DEFINITIONS[platform];
    const rootDirPath = join(cwd, definition.rootDir);
    
    // Check if the rootDir exists strictly in the cwd
    const detected = await exists(rootDirPath);
    
    return {
      name: platform,
      detected
    };
  });
  
  const detectionResults = await Promise.all(detectionPromises);
  return detectionResults;
}

/**
 * Get detected platforms only
 */
export async function getDetectedPlatforms(cwd: string): Promise<PlatformName[]> {
  const results = await detectAllPlatforms(cwd);
  return results.filter(result => result.detected).map(result => result.name);
}

/**
 * Create platform directories
 */
export async function createPlatformDirectories(
  cwd: string, 
  platforms: PlatformName[]
): Promise<string[]> {
  const created: string[] = [];
  const paths = getPlatformDirectoryPaths(cwd);
  
  for (const platform of platforms) {
    const platformPaths = paths[platform];
    
    try {
      await ensureDir(platformPaths.rulesDir);
      created.push(platformPaths.rulesDir);
      logger.debug(`Created platform directory: ${platformPaths.rulesDir}`);
    } catch (error) {
      logger.error(`Failed to create platform directory ${platformPaths.rulesDir}: ${error}`);
    }
  }
  
  return created;
}

/**
 * Validate platform directory structure
 */
export async function validatePlatformStructure(
  cwd: string, 
  platform: PlatformName
): Promise<{ valid: boolean; issues: string[] }> {
  const issues: string[] = [];
  const definition = PLATFORM_DEFINITIONS[platform];
  const paths = getPlatformDirectoryPaths(cwd);
  const platformPaths = paths[platform];
  
  // Check if rules directory exists
  if (!(await exists(platformPaths.rulesDir))) {
    issues.push(`Rules directory does not exist: ${platformPaths.rulesDir}`);
  }
  
    // Check root file for platforms that require it
    if ('rootFile' in definition && definition.rootFile && platformPaths.rootFile) {
      if (!(await exists(platformPaths.rootFile))) {
        issues.push(`Root file does not exist: ${platformPaths.rootFile}`);
      }
    }
  
  return {
    valid: issues.length === 0,
    issues
  };
}

/**
 * Get rules directory file patterns for a specific platform
 */
export function getPlatformRulesDirFilePatterns(platform: PlatformName): string[] {
  return [...PLATFORM_DEFINITIONS[platform].rulesDirFilePatterns];
}

/**
 * Check if a platform is of a specific category
 */
export function isPlatformCategory(platform: PlatformName, category: PlatformCategory): boolean {
  return PLATFORM_DEFINITIONS[platform].category === category;
}

/**
 * Get platform description
 */
export function getPlatformDescription(platform: PlatformName): string {
  return PLATFORM_DEFINITIONS[platform].description;
}
