/**
 * Platform Management Module
 * Centralized platform definitions, directory mappings, and file patterns
 * for all 13 supported AI coding platforms
 */

import { join, relative } from 'path';
import { exists, ensureDir } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { getPathLeaf } from '../utils/path-normalization.js';
import { PLATFORMS, PLATFORM_DIRS, FILE_PATTERNS, UNIVERSAL_SUBDIRS, type Platform, type UniversalSubdir } from '../constants/index.js';
import { mapPlatformFileToUniversal } from '../utils/platform-mapper.js';
import { parseUniversalPath } from '../utils/platform-file.js';

// All platforms
export const ALL_PLATFORMS = Object.values(PLATFORMS) as readonly Platform[];

/**
 * Lookup map from platform directory name to platform ID.
 * Used for quickly inferring platform from source directory.
 */
export const PLATFORM_DIR_LOOKUP: Record<string, Platform> = (() => {
  const map: Record<string, Platform> = {};
  for (const [dirKey, dirValue] of Object.entries(PLATFORM_DIRS)) {
    const platformId = (PLATFORMS as Record<string, Platform | undefined>)[dirKey as keyof typeof PLATFORMS];
    if (platformId) {
      map[dirValue] = platformId;
    }
  }
  return map;
})();

// New unified platform definition structure
export interface SubdirDef {
  // Base path under the platform root directory for this subdir
  // Examples: 'rules', 'memories', 'commands'
  path: string;
  // File patterns/extensions to read from this subdir (supports multiple, e.g. '.md', '.mdc', '.toml')
  // Empty array [] means allow all file extensions
  readExts: string[];
  // Preferred write extension for this subdir (e.g. '.mdc' for Cursor rules; '.md' default)
  // If undefined, preserve original file extension without conversion
  writeExt?: string;
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
      },
      [UNIVERSAL_SUBDIRS.SKILLS]: {
        path: 'skills',
        readExts: [],
        writeExt: undefined
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
    skillsDir?: string;
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
  const allPlatforms = Object.values(PLATFORMS) as Platform[];
  // Temporarily disable GEMINI platform
  return allPlatforms.filter(platform => platform !== PLATFORMS.GEMINI);
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

    const skillsSubdir = definition.subdirs[UNIVERSAL_SUBDIRS.SKILLS];
    if (skillsSubdir) {
      paths[platform].skillsDir = join(cwd, definition.rootDir, skillsSubdir.path);
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
  return definition.subdirs[UNIVERSAL_SUBDIRS.RULES]?.readExts || [];
}

/**
 * Get all universal subdirs that exist for a platform
 */
export function getPlatformUniversalSubdirs(cwd: string, platform: Platform): Array<{ dir: string; label: string; leaf: string }> {
  const paths = getPlatformDirectoryPaths(cwd);
  const platformPaths = paths[platform];
  const subdirs: Array<{ dir: string; label: string; leaf: string }> = [];

  if (platformPaths.rulesDir) subdirs.push({ dir: platformPaths.rulesDir, label: UNIVERSAL_SUBDIRS.RULES, leaf: getPathLeaf(platformPaths.rulesDir) });
  if (platformPaths.commandsDir) subdirs.push({ dir: platformPaths.commandsDir, label: UNIVERSAL_SUBDIRS.COMMANDS, leaf: getPathLeaf(platformPaths.commandsDir) });
  if (platformPaths.agentsDir) subdirs.push({ dir: platformPaths.agentsDir, label: UNIVERSAL_SUBDIRS.AGENTS, leaf: getPathLeaf(platformPaths.agentsDir) });
  if (platformPaths.skillsDir) subdirs.push({ dir: platformPaths.skillsDir, label: UNIVERSAL_SUBDIRS.SKILLS, leaf: getPathLeaf(platformPaths.skillsDir) });

  return subdirs;
}

/**
 * Check if a normalized path represents a universal subdir
 */
export function isUniversalSubdirPath(normalizedPath: string): boolean {
  return Object.values(UNIVERSAL_SUBDIRS).some(subdir =>
    normalizedPath.startsWith(`${subdir}/`) || normalizedPath === subdir
  );
}

/**
 * Check if a subKey is a valid universal subdir
 * Used for validating subdir keys before processing
 */
export function isValidUniversalSubdir(subKey: string): boolean {
  return Object.values(UNIVERSAL_SUBDIRS).includes(subKey as typeof UNIVERSAL_SUBDIRS[keyof typeof UNIVERSAL_SUBDIRS]);
}

/**
 * Check if a value is a valid platform ID.
 */
export function isPlatformId(value: string | undefined): value is Platform {
  return !!value && Object.values(PLATFORMS).includes(value as Platform);
}

/**
 * Infer platform from workspace file information.
 * Attempts multiple strategies to determine the platform:
 * 1. Maps full path to universal path (if platform can be inferred from path structure)
 * 2. Checks if source directory or registry path indicates AI directory
 * 3. Looks up platform from source directory using PLATFORM_DIR_LOOKUP
 * 4. Parses registry path for platform suffix (e.g., file.cursor.md)
 * 
 * @param fullPath - Full absolute path to the file
 * @param sourceDir - Source directory name (e.g., '.cursor', 'ai')
 * @param registryPath - Registry path (e.g., 'rules/file.md')
 * @returns Platform ID, 'ai', or undefined if cannot be determined
 */
export function inferPlatformFromWorkspaceFile(
  fullPath: string,
  sourceDir: string,
  registryPath: string
): Platform | 'ai' | undefined {
  // First try to get platform from full path using existing mapper
  const mapping = mapPlatformFileToUniversal(fullPath);
  if (mapping?.platform) {
    return mapping.platform;
  }

  // Check for AI directory
  if (sourceDir === PLATFORM_DIRS.AI || registryPath.startsWith(`${PLATFORM_DIRS.AI}/`)) {
    return 'ai';
  }

  // Look up platform from source directory
  const fromSource = PLATFORM_DIR_LOOKUP[sourceDir];
  if (fromSource) {
    return fromSource;
  }

  // Fallback: check registry path for platform suffix
  const parsed = parseUniversalPath(registryPath, { allowPlatformSuffix: true });
  if (parsed?.platformSuffix && isPlatformId(parsed.platformSuffix)) {
    return parsed.platformSuffix;
  }

  return undefined;
}

