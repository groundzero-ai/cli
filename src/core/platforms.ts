/**
 * Platform Management Module
 * Centralized platform definitions, directory mappings, and file patterns
 * for all 13 supported AI coding platforms
 */

import { join, relative } from 'path';
import { exists, ensureDir } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { getPathLeaf } from '../utils/path-normalization.js';
import { DIR_PATTERNS, FILE_PATTERNS, UNIVERSAL_SUBDIRS, type UniversalSubdir } from '../constants/index.js';
import { mapPlatformFileToUniversal } from '../utils/platform-mapper.js';
import { parseUniversalPath } from '../utils/platform-file.js';
import { readJsoncFileSync } from '../utils/jsonc.js';

export type Platform = string;

// New unified platform definition structure
export interface SubdirFileTransformation {
  packageExt: string;
  workspaceExt: string;
}

export interface SubdirDef {
  // Base path under the platform root directory for this subdir
  // Examples: 'rules', 'memories', 'commands'
  path: string;
  // Allowed workspace file extensions; undefined = all allowed, [] = none allowed
  exts?: string[];
  // Optional extension transformations between package (registry) and workspace
  transformations?: SubdirFileTransformation[];
}

export interface PlatformDefinition {
  id: Platform;
  name: string;
  rootDir: string;
  rootFile?: string;
  subdirs: Partial<Record<UniversalSubdir, SubdirDef>>;
  aliases?: string[];
  enabled: boolean;
}

// Types for JSONC config structure
interface PlatformConfig {
  name: string;
  rootDir: string;
  rootFile?: string;
  subdirs: Partial<Record<string, SubdirDef>>;
  aliases?: string[];
  enabled?: boolean;
}

type PlatformsConfig = Record<string, PlatformConfig>;

/**
 * Normalize subdir config from JSONC to internal SubdirDef format
 */
function normalizeSubdirs(
  subdirs: Partial<Record<string, SubdirDef>> | undefined
): Partial<Record<UniversalSubdir, SubdirDef>> {
  if (!subdirs) {
    return {};
  }

  const normalized: Partial<Record<UniversalSubdir, SubdirDef>> = {};

  for (const [subdirKey, subdirConfig] of Object.entries(subdirs)) {
    // Validate that the subdir key is a valid universal subdir
    if (!isValidUniversalSubdir(subdirKey)) {
      logger.warn(`Invalid universal subdir key in platforms.jsonc: ${subdirKey}`);
      continue;
    }

    // Skip if subdirConfig is undefined
    if (!subdirConfig) {
      continue;
    }

    normalized[subdirKey as UniversalSubdir] = subdirConfig;
  }

  return normalized;
}

/**
 * Load platform definitions from platforms.jsonc file
 */
function loadPlatformDefinitionsFromConfig(): Record<Platform, PlatformDefinition> {
  const raw = readJsoncFileSync<PlatformsConfig>('platforms.jsonc');
  const result: Partial<Record<Platform, PlatformDefinition>> = {};

  for (const [id, cfg] of Object.entries(raw)) {
    const platformId = id as Platform;

    result[platformId] = {
      id: platformId,
      name: cfg.name,
      rootDir: cfg.rootDir,
      rootFile: cfg.rootFile,
      subdirs: normalizeSubdirs(cfg.subdirs),
      aliases: cfg.aliases,
      enabled: cfg.enabled !== false
    };
  }

  return result as Record<Platform, PlatformDefinition>;
}

// Unified platform definitions loaded from platforms.jsonc
export const PLATFORM_DEFINITIONS: Record<Platform, PlatformDefinition> =
  loadPlatformDefinitionsFromConfig();

const PLATFORM_IDS = Object.freeze(Object.keys(PLATFORM_DEFINITIONS) as Platform[]);

// All platforms (including disabled) for internal reference
export const ALL_PLATFORMS = PLATFORM_IDS;

/**
 * Lookup map from platform directory name to platform ID.
 * Used for quickly inferring platform from source directory.
 */
export const PLATFORM_DIR_LOOKUP: Record<string, Platform> = (() => {
  const map: Record<string, Platform> = {};
  for (const def of Object.values(PLATFORM_DEFINITIONS)) {
    map[def.rootDir] = def.id;
  }
  return map;
})();

const PLATFORM_ALIAS_LOOKUP: Record<string, Platform> = (() => {
  const map: Record<string, Platform> = {};
  for (const def of Object.values(PLATFORM_DEFINITIONS)) {
    for (const alias of def.aliases ?? []) {
      map[alias.toLowerCase()] = def.id;
    }
  }
  return map;
})();

const PLATFORM_ROOT_FILES = Object.freeze(
  Object.values(PLATFORM_DEFINITIONS)
    .map(def => def.rootFile)
    .filter((file): file is string => typeof file === 'string')
);

// Legacy type definitions for compatibility
export type PlatformName = Platform;
export type PlatformCategory = string;

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
export function getAllPlatforms(options?: { includeDisabled?: boolean }): Platform[] {
  if (options?.includeDisabled) {
    return [...PLATFORM_IDS];
  }
  return PLATFORM_IDS.filter(platform => PLATFORM_DEFINITIONS[platform].enabled);
}

export function resolvePlatformName(input: string | undefined): Platform | undefined {
  if (!input) {
    return undefined;
  }

  const normalized = input.toLowerCase();
  if (normalized in PLATFORM_DEFINITIONS) {
    return normalized as Platform;
  }

  return PLATFORM_ALIAS_LOOKUP[normalized];
}

export function getAllRootFiles(): string[] {
  return [...PLATFORM_ROOT_FILES];
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
  return definition.subdirs[UNIVERSAL_SUBDIRS.RULES]?.exts || [];
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
  return Object.values(UNIVERSAL_SUBDIRS).some(subdir => {
    return (
      normalizedPath.startsWith(`${subdir}/`) ||
      normalizedPath === subdir ||
      normalizedPath.startsWith(`${DIR_PATTERNS.OPENPACKAGE}/${subdir}/`) ||
      normalizedPath === `${DIR_PATTERNS.OPENPACKAGE}/${subdir}`
    );
  });
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
  return !!value && value in PLATFORM_DEFINITIONS;
}

/**
 * Determine whether an extension is allowed for a given subdir definition.
 */
export function isExtAllowed(subdirDef: SubdirDef | undefined, ext: string): boolean {
  if (!subdirDef) {
    return false;
  }
  if (subdirDef.exts === undefined) {
    return true;
  }
  if (subdirDef.exts.length === 0) {
    return false;
  }
  return subdirDef.exts.includes(ext);
}

/**
 * Convert a package (registry) extension to the workspace extension.
 * Falls back to the original extension if no transformation applies.
 */
export function getWorkspaceExt(subdirDef: SubdirDef, packageExt: string): string {
  if (!subdirDef.transformations || packageExt === '') {
    return packageExt;
  }
  const transformation = subdirDef.transformations.find(
    ({ packageExt: candidate }) => candidate === packageExt
  );
  return transformation?.workspaceExt ?? packageExt;
}

/**
 * Convert a workspace extension to the package (registry) extension.
 * Falls back to the original extension if no transformation applies.
 */
export function getPackageExt(subdirDef: SubdirDef, workspaceExt: string): string {
  if (!subdirDef.transformations || workspaceExt === '') {
    return workspaceExt;
  }
  const transformation = subdirDef.transformations.find(
    ({ workspaceExt: candidate }) => candidate === workspaceExt
  );
  return transformation?.packageExt ?? workspaceExt;
}

/**
 * Infer platform from workspace file information.
 * Attempts multiple strategies to determine the platform:
 * 1. Maps full path to universal path (if platform can be inferred from path structure)
 * 2. Checks if source directory or registry path indicates workspace install content
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
): Platform | undefined {
  // First try to get platform from full path using existing mapper
  const mapping = mapPlatformFileToUniversal(fullPath);
  if (mapping?.platform) {
    return mapping.platform;
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

