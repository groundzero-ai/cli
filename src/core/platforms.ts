/**
 * Platform Management Module
 * Centralized platform definitions, directory mappings, and file patterns
 * for all 13 supported AI coding platforms
 */

import { join } from 'path';
import { exists, ensureDir, listFiles } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { PLATFORMS, PLATFORM_DIRS, FILE_PATTERNS, UNIVERSAL_SUBDIRS, type Platform, type UniversalSubdir, type PlatformDir } from '../constants/index.js';

// Platform Categories
export const PLATFORM_CATEGORIES = {
  AGENTS_MEMORIES: 'agents-memories',
  ROOT_MEMORIES: 'root-memories',
  RULES_DIRECTORY: 'rules-directory'
} as const;

// All platforms combined
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
  // Special AI directory platform
  [PLATFORMS.AI]: {
    id: PLATFORMS.AI,
    rootDir: PLATFORM_DIRS.AI,
    subdirs: {
      [UNIVERSAL_SUBDIRS.RULES]: {
        path: '',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      }
    },
    description: 'AI directory - ai/ (*.md files)'
  },
  // AGENTS.md + MEMORIES platforms
  [PLATFORMS.CODEXCLI]: {
    id: PLATFORMS.CODEXCLI,
    rootDir: PLATFORM_DIRS.CODEXCLI,
    rootFile: FILE_PATTERNS.AGENTS_MD,
    subdirs: {
      [UNIVERSAL_SUBDIRS.RULES]: {
        path: 'memories',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      },
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
    description: 'OpenAI Codex CLI - AGENTS.md + .codex/memories/ + .codex/commands + .codex/agents'
  },
  [PLATFORMS.OPENCODE]: {
    id: PLATFORMS.OPENCODE,
    rootDir: PLATFORM_DIRS.OPENCODE,
    rootFile: FILE_PATTERNS.AGENTS_MD,
    subdirs: {
      [UNIVERSAL_SUBDIRS.RULES]: {
        path: 'memories',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      },
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
    description: 'OpenCode - AGENTS.md + .opencode/memories/ + .opencode/commands + .opencode/agents'
  },

  // Similar Root + Memories platforms
  [PLATFORMS.CLAUDECODE]: {
    id: PLATFORMS.CLAUDECODE,
    rootDir: PLATFORM_DIRS.CLAUDECODE,
    rootFile: FILE_PATTERNS.CLAUDE_MD,
    subdirs: {
      [UNIVERSAL_SUBDIRS.RULES]: {
        path: 'memories',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      },
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
    description: 'Claude Code - CLAUDE.md + .claude/memories/ + .claude/commands + .claude/agents'
  },
  [PLATFORMS.QWENCODE]: {
    id: PLATFORMS.QWENCODE,
    rootDir: PLATFORM_DIRS.QWENCODE,
    rootFile: FILE_PATTERNS.QWEN_MD,
    subdirs: {
      [UNIVERSAL_SUBDIRS.RULES]: {
        path: 'memories',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      },
      [UNIVERSAL_SUBDIRS.AGENTS]: {
        path: 'agents',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      }
    },
    description: 'Qwen Code - QWEN.md + .qwen/memories/ + .qwen/agents'
  },
  [PLATFORMS.GEMINICLI]: {
    id: PLATFORMS.GEMINICLI,
    rootDir: PLATFORM_DIRS.GEMINICLI,
    rootFile: FILE_PATTERNS.GEMINI_MD,
    subdirs: {
      [UNIVERSAL_SUBDIRS.RULES]: {
        path: 'memories',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      },
      [UNIVERSAL_SUBDIRS.COMMANDS]: {
        path: 'commands',
        readExts: ['.toml'],
        writeExt: '.toml'
      }
    },
    description: 'Gemini CLI - GEMINI.md + .gemini/memories/ + .gemini/commands (.toml files)'
  },
  [PLATFORMS.WARP]: {
    id: PLATFORMS.WARP,
    rootDir: PLATFORM_DIRS.WARP,
    rootFile: FILE_PATTERNS.WARP_MD,
    subdirs: {
      [UNIVERSAL_SUBDIRS.RULES]: {
        path: 'memories',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      }
    },
    description: 'Warp - WARP.md + .warp/memories/'
  },

  // Rules Directory platforms
  [PLATFORMS.CURSOR]: {
    id: PLATFORMS.CURSOR,
    rootDir: PLATFORM_DIRS.CURSOR,
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
    description: 'Cursor - .cursor/rules/ (*.mdc files) + .cursor/commands'
  },
  [PLATFORMS.CLINE]: {
    id: PLATFORMS.CLINE,
    rootDir: PLATFORM_DIRS.CLINE,
    subdirs: {
      [UNIVERSAL_SUBDIRS.RULES]: {
        path: '',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      }
    },
    description: 'Cline - .clinerules/ (*.md files)'
  },
  [PLATFORMS.ROO]: {
    id: PLATFORMS.ROO,
    rootDir: PLATFORM_DIRS.ROO,
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
    description: 'Roo Code - .roo/rules/ (*.md files) + .roo/commands'
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
    description: 'Windsurf - .windsurf/rules/ (*.md files)'
  },
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
    description: 'AugmentCode - .augment/rules/ (*.md files) + .augment/commands'
  },
  [PLATFORMS.KIRO]: {
    id: PLATFORMS.KIRO,
    rootDir: PLATFORM_DIRS.KIRO,
    subdirs: {
      [UNIVERSAL_SUBDIRS.RULES]: {
        path: 'steering',
        readExts: [FILE_PATTERNS.MD_FILES],
        writeExt: FILE_PATTERNS.MD_FILES
      }
    },
    description: 'Kiro IDE - .kiro/steering/ (*.md files)'
  }
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
