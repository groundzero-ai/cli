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
    rootFile: FILE_PATTERNS.AGENTS_MD,
    rulesDir: `${PLATFORM_DIRS.CODEXCLI}/${PLATFORM_SUBDIRS.MEMORIES}`,
    filePatterns: [FILE_PATTERNS.MD_FILES] as const,
    description: 'OpenAI Codex CLI - AGENTS.md + .codex/memories/'
  },
  [PLATFORMS.OPENCODE]: {
    name: PLATFORMS.OPENCODE,
    category: PLATFORM_CATEGORIES.AGENTS_MEMORIES,
    rootFile: FILE_PATTERNS.AGENTS_MD,
    rulesDir: `${PLATFORM_DIRS.OPENCODE}/${PLATFORM_SUBDIRS.MEMORIES}`,
    filePatterns: [FILE_PATTERNS.MD_FILES] as const,
    description: 'OpenCode - AGENTS.md + .opencode/memories/'
  },
  
  // Similar Root + Memories platforms
  [PLATFORMS.CLAUDECODE]: {
    name: PLATFORMS.CLAUDECODE,
    category: PLATFORM_CATEGORIES.ROOT_MEMORIES,
    rootFile: FILE_PATTERNS.CLAUDE_MD,
    rulesDir: `${PLATFORM_DIRS.CLAUDECODE}/${PLATFORM_SUBDIRS.MEMORIES}`,
    filePatterns: [FILE_PATTERNS.MD_FILES] as const,
    description: 'Claude Code - CLAUDE.md + .claude/memories/'
  },
  [PLATFORMS.QWENCODE]: {
    name: PLATFORMS.QWENCODE,
    category: PLATFORM_CATEGORIES.ROOT_MEMORIES,
    rootFile: FILE_PATTERNS.QWEN_MD,
    rulesDir: `${PLATFORM_DIRS.QWENCODE}/${PLATFORM_SUBDIRS.MEMORIES}`,
    filePatterns: [FILE_PATTERNS.MD_FILES] as const,
    description: 'Qwen Code - QWEN.md + .qwen/memories/'
  },
  [PLATFORMS.GEMINICLI]: {
    name: PLATFORMS.GEMINICLI,
    category: PLATFORM_CATEGORIES.ROOT_MEMORIES,
    rootFile: FILE_PATTERNS.GEMINI_MD,
    rulesDir: `${PLATFORM_DIRS.GEMINICLI}/${PLATFORM_SUBDIRS.MEMORIES}`,
    filePatterns: [FILE_PATTERNS.MD_FILES] as const,
    description: 'Gemini CLI - GEMINI.md + .gemini/memories/'
  },
  [PLATFORMS.WARP]: {
    name: PLATFORMS.WARP,
    category: PLATFORM_CATEGORIES.ROOT_MEMORIES,
    rootFile: FILE_PATTERNS.WARP_MD,
    rulesDir: `${PLATFORM_DIRS.WARP}/${PLATFORM_SUBDIRS.MEMORIES}`,
    filePatterns: [FILE_PATTERNS.MD_FILES] as const,
    description: 'Warp - WARP.md + .warp/memories/'
  },
  
  // Rules Directory platforms
  [PLATFORMS.CURSOR]: {
    name: PLATFORMS.CURSOR,
    category: PLATFORM_CATEGORIES.RULES_DIRECTORY,
    rulesDir: `${PLATFORM_DIRS.CURSOR}/${PLATFORM_SUBDIRS.RULES}`,
    filePatterns: [FILE_PATTERNS.MDC_FILES] as const,
    description: 'Cursor - .cursor/rules/ (*.mdc files)'
  },
  [PLATFORMS.CLINE]: {
    name: PLATFORMS.CLINE,
    category: PLATFORM_CATEGORIES.RULES_DIRECTORY,
    rulesDir: PLATFORM_DIRS.CLINE,
    filePatterns: [FILE_PATTERNS.MD_FILES] as const,
    description: 'Cline - .clinerules/ (*.md files)'
  },
  [PLATFORMS.ROO]: {
    name: PLATFORMS.ROO,
    category: PLATFORM_CATEGORIES.RULES_DIRECTORY,
    rulesDir: `${PLATFORM_DIRS.ROO}/${PLATFORM_SUBDIRS.RULES}`,
    filePatterns: [FILE_PATTERNS.MD_FILES] as const,
    description: 'Roo Code - .roo/rules/ (*.md files)'
  },
  [PLATFORMS.WINDSURF]: {
    name: PLATFORMS.WINDSURF,
    category: PLATFORM_CATEGORIES.RULES_DIRECTORY,
    rulesDir: `${PLATFORM_DIRS.WINDSURF}/${PLATFORM_SUBDIRS.RULES}`,
    filePatterns: [FILE_PATTERNS.MD_FILES] as const,
    description: 'Windsurf - .windsurf/rules/ (*.md files)'
  },
  [PLATFORMS.AUGMENT]: {
    name: PLATFORMS.AUGMENT,
    category: PLATFORM_CATEGORIES.RULES_DIRECTORY,
    rulesDir: `${PLATFORM_DIRS.AUGMENT}/${PLATFORM_SUBDIRS.RULES}`,
    filePatterns: [FILE_PATTERNS.MD_FILES] as const,
    description: 'AugmentCode - .augment/rules/ (*.md files)'
  },
  [PLATFORMS.KIRO]: {
    name: PLATFORMS.KIRO,
    category: PLATFORM_CATEGORIES.RULES_DIRECTORY,
    rulesDir: `${PLATFORM_DIRS.KIRO}/${PLATFORM_SUBDIRS.STEERING}`,
    filePatterns: [FILE_PATTERNS.MD_FILES] as const,
    description: 'Kiro IDE - .kiro/steering/ (*.md files)'
  }
} as const;

// Type definitions
export type PlatformName = Platform;
export type PlatformCategory = typeof PLATFORM_CATEGORIES[keyof typeof PLATFORM_CATEGORIES];

export interface PlatformDefinition {
  name: PlatformName;
  category: PlatformCategory;
  rootFile?: string;
  rulesDir: string;
  filePatterns: readonly string[];
  description: string;
}

export interface PlatformDetectionResult {
  name: PlatformName;
  detected: boolean;
  directoryExists: boolean;
  filesPresent: boolean;
  category: PlatformCategory;
}

export interface PlatformDirectoryPaths {
  [platformName: string]: {
    rulesDir: string;
    rootFile?: string;
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
  }
  
  return paths;
}

/**
 * Detect all platforms present in a directory
 */
export async function detectAllPlatforms(cwd: string): Promise<PlatformDetectionResult[]> {
  const results: PlatformDetectionResult[] = [];
  const paths = getPlatformDirectoryPaths(cwd);
  
  // Check all platforms in parallel
  const detectionPromises = ALL_PLATFORMS.map(async (platform) => {
    const definition = PLATFORM_DEFINITIONS[platform];
    const platformPaths = paths[platform];
    
    // Check directory existence
    const directoryExists = await exists(platformPaths.rulesDir);
    
    // Check root file existence (for platforms that have one)
    let rootFileExists = true;
    if ('rootFile' in definition && definition.rootFile && platformPaths.rootFile) {
      rootFileExists = await exists(platformPaths.rootFile);
    }
    
    // Check for files in rules directory
    let filesPresent = false;
    if (directoryExists) {
      try {
        const files = await listFiles(platformPaths.rulesDir);
        filesPresent = files.some(file => 
          definition.filePatterns.some(pattern => file.endsWith(pattern))
        );
      } catch (error) {
        logger.debug(`Failed to list files in ${platformPaths.rulesDir}: ${error}`);
      }
    }
    
    const detected = directoryExists && rootFileExists;
    
    return {
      name: platform,
      detected,
      directoryExists,
      filesPresent,
      category: definition.category
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
 * Get file patterns for a specific platform
 */
export function getPlatformFilePatterns(platform: PlatformName): string[] {
  return [...PLATFORM_DEFINITIONS[platform].filePatterns];
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
