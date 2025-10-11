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
  rootDir: string;
  rootFile?: string;
  subdirs: Partial<Record<UniversalSubdir, SubdirDef>>;
  description: string;
}

// Unified platform definitions using the new structure
export const PLATFORM_DEFINITIONS: Record<Platform, PlatformDefinition> = {

  [PLATFORMS.AUGMENT]: {
    id: PLATFORMS.AUGMENT,
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
    },
    description: 'Augment Code'
  },

  [PLATFORMS.CLAUDE]: {
    id: PLATFORMS.CLAUDE,
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
    },
    description: 'Claude Code'
  },

  [PLATFORMS.CODEX]: {
    id: PLATFORMS.CODEX,
    rootDir: PLATFORM_DIRS.CODEX,
    rootFile: FILE_PATTERNS.AGENTS_MD,
    subdirs: {
      [UNIVERSAL_SUBDIRS.COMMANDS]: {
        path: 'prompts',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      },
    },
    description: 'OpenAI Codex CLI'
  },

  [PLATFORMS.CURSOR]: {
    id: PLATFORMS.CURSOR,
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
    },
    description: 'Cursor'
  },

  [PLATFORMS.FACTORY]: {
    id: PLATFORMS.FACTORY,
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
    },
    description: 'Factory AI'
  },

  [PLATFORMS.GEMINI]: {
    id: PLATFORMS.GEMINI,
    rootDir: PLATFORM_DIRS.GEMINI,
    rootFile: FILE_PATTERNS.GEMINI_MD,
    subdirs: {
      [UNIVERSAL_SUBDIRS.COMMANDS]: {
        path: 'commands',
        readExts: [FILE_PATTERNS.TOML_FILES],
        writeExt: FILE_PATTERNS.TOML_FILES
      }
    },
    description: 'Gemini CLI'
  },

  [PLATFORMS.KILO]: {
    id: PLATFORMS.KILO,
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
    },
    description: 'Kilo Code'
  },

  [PLATFORMS.KIRO]: {
    id: PLATFORMS.KIRO,
    rootDir: PLATFORM_DIRS.KIRO,
    subdirs: {
      [UNIVERSAL_SUBDIRS.RULES]: {
        path: 'steering',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      },
    },
    description: 'Kiro'
  },

  [PLATFORMS.OPENCODE]: {
    id: PLATFORMS.OPENCODE,
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
    },
    description: 'opencode'
  },

  [PLATFORMS.QWEN]: {
    id: PLATFORMS.QWEN,
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
    },
    description: 'Qwen Code'
  },

  [PLATFORMS.ROO]: {
    id: PLATFORMS.ROO,
    rootDir: PLATFORM_DIRS.ROO,
    rootFile: FILE_PATTERNS.AGENTS_MD,
    subdirs: {
      [UNIVERSAL_SUBDIRS.COMMANDS]: {
        path: 'commands',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      },
    },
    description: 'Roo Code'
  },

  [PLATFORMS.WARP]: {
    id: PLATFORMS.WARP,
    rootDir: PLATFORM_DIRS.WARP,
    rootFile: FILE_PATTERNS.WARP_MD,
    subdirs: {
    },
    description: 'Warp'
  },

  [PLATFORMS.WINDSURF]: {
    id: PLATFORMS.WINDSURF,
    rootDir: PLATFORM_DIRS.WINDSURF,
    subdirs: {
      [UNIVERSAL_SUBDIRS.RULES]: {
        path: 'rules',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      }
    },
    description: 'Windsurf'
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
 * Detect all platforms present in a directory
 */
export async function detectAllPlatforms(cwd: string): Promise<PlatformDetectionResult[]> {
  // Check all platforms in parallel
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

/**
 * Get platform description
 */
export function getPlatformDescription(platform: Platform): string {
  return getPlatformDefinition(platform).description;
}
