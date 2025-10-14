/**
 * Platform Management Module
 * Centralized platform definitions, directory mappings, and file patterns
 * for all 13 supported AI coding platforms
 */

import { join, relative } from 'path';
import { exists, ensureDir } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { PLATFORMS, PLATFORM_DIRS, FILE_PATTERNS, UNIVERSAL_SUBDIRS, type Platform, type UniversalSubdir } from '../constants/index.js';

// All platforms
export const ALL_PLATFORMS = Object.values(PLATFORMS) as readonly Platform[];

// New unified platform definition structure
export interface SubdirDef {
  // Base path under the platform root directory for this subdir
  // Examples: 'rules', 'memories', 'commands'
  path: string;
  // File patterns/extensions to read from this subdir (supports multiple, e.g. '.md', '.mdc', '.toml')
  readExts: string[];
  // Preferred write extension for this subdir (e.g. '.mdc' for Cursor rules; '.md' default)
  writeExt: string;
}

export interface PlatformDefinition {
  id: Platform;
  name: string;
  rootDir: string;
  rootFile?: string;
  subdirs: Partial<Record<UniversalSubdir, SubdirDef>>;
}

// Unified platform definitions using the new structure
export const PLATFORM_DEFINITIONS: Record<Platform, PlatformDefinition> = {

  [PLATFORMS.AUGMENT]: {
    id: PLATFORMS.AUGMENT,
    name: 'Augment Code',
    rootDir: PLATFORM_DIRS.AUGMENT,
    subdirs: {
      [UNIVERSAL_SUBDIRS.RULES]: {
        path: 'rules',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      },
      [UNIVERSAL_SUBDIRS.COMMANDS]: {
        path: 'commands',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      }
    }
  },

  [PLATFORMS.CLAUDE]: {
    id: PLATFORMS.CLAUDE,
    name: 'Claude Code',
    rootDir: PLATFORM_DIRS.CLAUDE,
    rootFile: FILE_PATTERNS.CLAUDE_MD,
    subdirs: {
      [UNIVERSAL_SUBDIRS.COMMANDS]: {
        path: 'commands',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      },
      [UNIVERSAL_SUBDIRS.AGENTS]: {
        path: 'agents',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      }
    }
  },

  [PLATFORMS.CODEX]: {
    id: PLATFORMS.CODEX,
    name: 'Codex CLI',
    rootDir: PLATFORM_DIRS.CODEX,
    rootFile: FILE_PATTERNS.AGENTS_MD,
    subdirs: {
      [UNIVERSAL_SUBDIRS.COMMANDS]: {
        path: 'prompts',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      },
    }
  },

  [PLATFORMS.CURSOR]: {
    id: PLATFORMS.CURSOR,
    name: 'Cursor',
    rootDir: PLATFORM_DIRS.CURSOR,
    rootFile: FILE_PATTERNS.AGENTS_MD,
    subdirs: {
      [UNIVERSAL_SUBDIRS.RULES]: {
        path: 'rules',
        readExts: [FILE_PATTERNS.MDC_FILES, FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MDC_FILES
      },
      [UNIVERSAL_SUBDIRS.COMMANDS]: {
        path: 'commands',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      }
    }
  },

  [PLATFORMS.FACTORY]: {
    id: PLATFORMS.FACTORY,
    name: 'Factory AI',
    rootDir: PLATFORM_DIRS.FACTORY,
    rootFile: FILE_PATTERNS.AGENTS_MD,
    subdirs: {
      [UNIVERSAL_SUBDIRS.COMMANDS]: {
        path: 'commands',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      },
      [UNIVERSAL_SUBDIRS.AGENTS]: {
        path: 'droids',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      }
    }
  },

  [PLATFORMS.GEMINI]: {
    id: PLATFORMS.GEMINI,
    name: 'Gemini CLI',
    rootDir: PLATFORM_DIRS.GEMINI,
    rootFile: FILE_PATTERNS.GEMINI_MD,
    subdirs: {
      [UNIVERSAL_SUBDIRS.COMMANDS]: {
        path: 'commands',
        readExts: [FILE_PATTERNS.TOML_FILES],
        writeExt: FILE_PATTERNS.TOML_FILES
      }
    }
  },

  [PLATFORMS.KILO]: {
    id: PLATFORMS.KILO,
    name: 'Kilo Code',
    rootDir: PLATFORM_DIRS.KILO,
    rootFile: FILE_PATTERNS.AGENTS_MD,
    subdirs: {
      [UNIVERSAL_SUBDIRS.RULES]: {
        path: 'rules',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      },
      [UNIVERSAL_SUBDIRS.COMMANDS]: {
        path: 'workflows',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      },
    }
  },

  [PLATFORMS.KIRO]: {
    id: PLATFORMS.KIRO,
    name: 'Kiro',
    rootDir: PLATFORM_DIRS.KIRO,
    subdirs: {
      [UNIVERSAL_SUBDIRS.RULES]: {
        path: 'steering',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      },
    }
  },

  [PLATFORMS.OPENCODE]: {
    id: PLATFORMS.OPENCODE,
    name: 'OpenCode',
    rootDir: PLATFORM_DIRS.OPENCODE,
    rootFile: FILE_PATTERNS.AGENTS_MD,
    subdirs: {
      [UNIVERSAL_SUBDIRS.COMMANDS]: {
        path: 'command',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      },
      [UNIVERSAL_SUBDIRS.AGENTS]: {
        path: 'agent',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      }
    }
  },

  [PLATFORMS.QWEN]: {
    id: PLATFORMS.QWEN,
    name: 'Qwen Code',
    rootDir: PLATFORM_DIRS.QWEN,
    rootFile: FILE_PATTERNS.QWEN_MD,
    subdirs: {
      [UNIVERSAL_SUBDIRS.COMMANDS]: {
        path: 'commands',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      },
      [UNIVERSAL_SUBDIRS.AGENTS]: {
        path: 'agents',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      }
    }
  },

  [PLATFORMS.ROO]: {
    id: PLATFORMS.ROO,
    name: 'Roo Code',
    rootDir: PLATFORM_DIRS.ROO,
    rootFile: FILE_PATTERNS.AGENTS_MD,
    subdirs: {
      [UNIVERSAL_SUBDIRS.COMMANDS]: {
        path: 'commands',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      },
    }
  },

  [PLATFORMS.WARP]: {
    id: PLATFORMS.WARP,
    name: 'Warp',
    rootDir: PLATFORM_DIRS.WARP,
    rootFile: FILE_PATTERNS.WARP_MD,
    subdirs: {
    }
  },

  [PLATFORMS.WINDSURF]: {
    id: PLATFORMS.WINDSURF,
    name: 'Windsurf',
    rootDir: PLATFORM_DIRS.WINDSURF,
    subdirs: {
      [UNIVERSAL_SUBDIRS.RULES]: {
        path: 'rules',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      }
    }
  },

} as const;

// Legacy type definitions for compatibility
export type PlatformName = Platform;
export type PlatformCategory = string;
export type { Platform };

export interface PlatformDetectionResult {
  name: Platform;
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
export function getPlatformDefinition(name: Platform): PlatformDefinition {
  return PLATFORM_DEFINITIONS[name];
}

/**
 * Get all platforms
 */
export function getAllPlatforms(): Platform[] {
  return Object.values(PLATFORMS) as Platform[];
}

/**
 * Get platform directory paths for a given working directory
 */
export function getPlatformDirectoryPaths(cwd: string): PlatformDirectoryPaths {
  const paths: PlatformDirectoryPaths = {};

  for (const platform of getAllPlatforms()) {
    const definition = getPlatformDefinition(platform);
    const rulesSubdir = definition.subdirs[UNIVERSAL_SUBDIRS.RULES];
    paths[platform] = {
      rulesDir: join(cwd, definition.rootDir, rulesSubdir?.path || '')
    };

    if (definition.rootFile) {
      paths[platform].rootFile = join(cwd, definition.rootFile);
    }

    const commandsSubdir = definition.subdirs[UNIVERSAL_SUBDIRS.COMMANDS];
    if (commandsSubdir) {
      paths[platform].commandsDir = join(cwd, definition.rootDir, commandsSubdir.path);
    }

    const agentsSubdir = definition.subdirs[UNIVERSAL_SUBDIRS.AGENTS];
    if (agentsSubdir) {
      paths[platform].agentsDir = join(cwd, definition.rootDir, agentsSubdir.path);
    }
  }

  return paths;
}

/**
 * Detect platforms by their root files
 * Note: AGENTS.md is ambiguous (maps to multiple platforms), so we return empty for it
 */
export async function detectPlatformByRootFile(cwd: string): Promise<Platform[]> {
  const detectedPlatforms: Platform[] = [];

  // Build dynamic root file mapping from platform definitions
  const rootFileToPlatform = new Map<string, Platform>();
  for (const platform of getAllPlatforms()) {
    const def = getPlatformDefinition(platform);
    if (def.rootFile && def.rootFile !== FILE_PATTERNS.AGENTS_MD) {
      rootFileToPlatform.set(def.rootFile, platform);
    }
  }

  // Check for existence of each root file at cwd
  for (const [rootFile, platform] of rootFileToPlatform.entries()) {
    const filePath = join(cwd, rootFile);
    if (await exists(filePath)) {
      detectedPlatforms.push(platform);
    }
  }

  return detectedPlatforms;
}

/**
 * Detect all platforms present in a directory
 * Checks both platform directories and root files
 */
export async function detectAllPlatforms(cwd: string): Promise<PlatformDetectionResult[]> {
  // Check all platforms by directory in parallel
  const detectionPromises = getAllPlatforms().map(async (platform) => {
    const definition = getPlatformDefinition(platform);
    const rootDirPath = join(cwd, definition.rootDir);

    // Check if the rootDir exists strictly in the cwd
    const detected = await exists(rootDirPath);

    return {
      name: platform,
      detected
    };
  });

  const detectionResults = await Promise.all(detectionPromises);
  
  // Also detect by root files
  const rootFileDetectedPlatforms = await detectPlatformByRootFile(cwd);
  
  // Merge results - mark platforms as detected if they have either directory or root file
  for (const platform of rootFileDetectedPlatforms) {
    const result = detectionResults.find(r => r.name === platform);
    if (result && !result.detected) {
      result.detected = true;
    }
  }

  return detectionResults;
}

/**
 * Get detected platforms only
 */
export async function getDetectedPlatforms(cwd: string): Promise<Platform[]> {
  const results = await detectAllPlatforms(cwd);
  return results.filter(result => result.detected).map(result => result.name);
}

/**
 * Create platform directories
 */
export async function createPlatformDirectories(
  cwd: string,
  platforms: Platform[]
): Promise<string[]> {
  const created: string[] = [];
  const paths = getPlatformDirectoryPaths(cwd);

  for (const platform of platforms) {
    const platformPaths = paths[platform];

    try {
      const dirExists = await exists(platformPaths.rulesDir);
      if (!dirExists) {
        await ensureDir(platformPaths.rulesDir);
        created.push(relative(cwd, platformPaths.rulesDir));
        logger.debug(`Created platform directory: ${platformPaths.rulesDir}`);
      }
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
  platform: Platform
): Promise<{ valid: boolean; issues: string[] }> {
  const issues: string[] = [];
  const definition = getPlatformDefinition(platform);
  const paths = getPlatformDirectoryPaths(cwd);
  const platformPaths = paths[platform];

  // Check if rules directory exists
  if (!(await exists(platformPaths.rulesDir))) {
    issues.push(`Rules directory does not exist: ${platformPaths.rulesDir}`);
  }

  // Check root file for platforms that require it
  if (definition.rootFile && platformPaths.rootFile) {
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
export function getPlatformRulesDirFilePatterns(platform: Platform): string[] {
  const definition = getPlatformDefinition(platform);
  return definition.subdirs[UNIVERSAL_SUBDIRS.RULES]?.readExts || [FILE_PATTERNS.MD_FILES];
}

