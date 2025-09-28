import { Command } from 'commander';
import { join, dirname, basename, relative } from 'path';
import { SaveOptions, CommandResult, FormulaYml, FormulaFile } from '../types/index.js';
import { parseFormulaYml, writeFormulaYml, parseMarkdownFrontmatter, updateMarkdownWithFormulaFrontmatter } from '../utils/formula-yml.js';
import { detectTemplateFile } from '../utils/template.js';
import { ensureRegistryDirectories, getFormulaVersionPath, hasFormulaVersion } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, ValidationError } from '../utils/errors.js';
import { getLocalFormulasDir, getLocalFormulaDir } from '../utils/paths.js';
import { ensureLocalGroundZeroStructure, createBasicFormulaYml, addFormulaToYml } from '../utils/formula-management.js';
import { FILE_PATTERNS, PLATFORMS, PLATFORM_DIRS, PLATFORM_SUBDIRS, FORMULA_DIRS } from '../constants/index.js';

import { generateLocalVersion, isLocalVersion, extractBaseVersion } from '../utils/version-generator.js';
import { promptConfirmation } from '../utils/prompts.js';
import { calculateFileHash } from '../utils/hash-utils.js';
import { getTargetDirectory, getTargetFilePath } from '../utils/platform-utils.js';
import { resolveFileConflicts } from '../utils/conflict-resolution.js';
import {
  getDetectedPlatforms,
  getPlatformDefinition,
  getPlatformDirectoryPaths,
  type PlatformName
} from '../core/platforms.js';
import type { DiscoveredFile } from '../types/index.js';
import {
  exists,
  readTextFile,
  writeTextFile,
  listFiles,
  listDirectories,
  isDirectory,
  ensureDir,
  getStats
} from '../utils/fs.js';

// Constants
const UTF8_ENCODING = 'utf8' as const;
const DEFAULT_VERSION = '0.1.0';
const LOG_PREFIX_CREATED = '✓ Created formula.yml in';
const LOG_PREFIX_FOUND = '✓ Found existing formula.yml';
const LOG_PREFIX_NAME = '📦 Name:';
const LOG_PREFIX_VERSION = '📦 Version:';
const LOG_PREFIX_FILES = '📄 Found';
const LOG_PREFIX_FILES_SUFFIX = 'markdown files';
const LOG_PREFIX_RESOLVED = '📄 Resolved conflicts, keeping';
const LOG_PREFIX_SAVED = '✅ Saved';
const LOG_PREFIX_UPDATED = '✓ Updated frontmatter in';
const LOG_PREFIX_EXPLICIT_VERSION = '🎯 Using explicit version:';
const LOG_PREFIX_PRERELEASE = '🎯 No version found, setting to prerelease:';
const LOG_PREFIX_BUMP_STABLE = '🎯 Bumping to stable version:';
const LOG_PREFIX_BUMP_PRERELEASE = '🎯 Bumping to prerelease version:';
const LOG_PREFIX_CONVERT_STABLE = '🎯 Converting to stable version:';
const LOG_PREFIX_OVERWRITE_STABLE = '🎯 Overwriting stable version:';
const LOG_PREFIX_INCREMENT_PRERELEASE = '🎯 Incrementing prerelease version:';
const LOG_PREFIX_AUTO_INCREMENT = '🎯 Auto-incrementing to patch prerelease:';
const LOG_PREFIX_WARNING = '⚠️  Version';
const LOG_PREFIX_WARNING_SUFFIX = 'is already stable.';
const ARROW_SEPARATOR = ' → ';
const VERSION_TYPE_STABLE = 'stable';

/**
 * Check if a path matches a platform pattern and extract platform info
 */
function checkPlatformMatch(normalizedPath: string, platform: PlatformName, platformDir: string): { platform: string; relativePath: string; platformName: PlatformName } | null {
  // Check for absolute paths
  const absPlatformPattern = `/${platformDir}/`;
  let platformIndex = normalizedPath.indexOf(absPlatformPattern);
  let isAbsolute = true;

  if (platformIndex === -1) {
    // Check for relative paths
    const relPlatformPattern = `${platformDir}/`;
    platformIndex = normalizedPath.indexOf(relPlatformPattern);
    isAbsolute = false;
  }

  if (platformIndex !== -1) {
    const patternLength = isAbsolute ? absPlatformPattern.length - 1 : `${platformDir}/`.length - 1;
    const relativePath = normalizedPath.substring(platformIndex + patternLength);
    return { platform, relativePath: relativePath.startsWith('/') ? relativePath.substring(1) : relativePath, platformName: platform };
  }

  // Check for exact platform directory matches
  if (normalizedPath === `/${platformDir}` || normalizedPath === platformDir || normalizedPath.endsWith(`/${platformDir}`)) {
    return { platform, relativePath: '', platformName: platform };
  }

  return null;
}

/**
 * Parse a directory path to determine if it's a platform-specific directory
 */
function parsePlatformDirectory(directoryPath: string): { platform: string; relativePath: string; platformName: PlatformName } | null {
  const normalizedPath = directoryPath.replace(/\\/g, '/'); // Normalize for cross-platform

  // Check for AI directory first (special case)
  const aiMatch = checkPlatformMatch(normalizedPath, PLATFORM_DIRS.AI as PlatformName, PLATFORM_DIRS.AI);
  if (aiMatch) {
    return aiMatch;
  }

  // Check for other platforms
  const platforms = Object.values(PLATFORMS) as PlatformName[];
  for (const platform of platforms) {
    if (platform === (PLATFORM_DIRS.AI as PlatformName)) continue; // Already handled above

    const platformDir = PLATFORM_DIRS[platform as keyof typeof PLATFORM_DIRS];
    const match = checkPlatformMatch(normalizedPath, platform, platformDir);
    if (match) {
      return match;
    }
  }

  return null;
}

/**
 * Build platform-based search configuration for file discovery
 */
async function buildPlatformSearchConfig(cwd: string): Promise<PlatformSearchConfig[]> {
  const detectedPlatforms = await getDetectedPlatforms(cwd);
  const config: PlatformSearchConfig[] = [];

  // Add AI directory as required feature
  config.push({
    name: PLATFORM_DIRS.AI,
    platform: PLATFORM_DIRS.AI as PlatformName, // Special case for AI directory
    rootDir: PLATFORM_DIRS.AI,
    rulesDir: join(cwd, PLATFORM_DIRS.AI),
    filePatterns: [FILE_PATTERNS.MD_FILES],
    registryPath: '' // Empty for AI directory to avoid double ai/ prefix
  });

  // Add detected platform configurations
  for (const platform of detectedPlatforms) {
    const definition = getPlatformDefinition(platform);
    const paths = getPlatformDirectoryPaths(cwd);
    const platformPaths = paths[platform];

    config.push({
      name: platform,
      platform,
      rootDir: definition.rootDir,
      rulesDir: platformPaths.rulesDir,
      commandsDir: platformPaths.commandsDir,
      agentsDir: platformPaths.agentsDir,
      filePatterns: [...definition.filePatterns],
      registryPath: '' // Use empty registry path for universal storage
    });
  }

  return config;
}

// Platform search configuration interface
interface PlatformSearchConfig {
  name: string;
  platform: PlatformName;
  rootDir: string;
  rulesDir: string;
  commandsDir?: string;
  agentsDir?: string;
  filePatterns: string[];
  registryPath: string;
}

/**
 * Parse formula inputs to handle three usage patterns:
 * 1. Explicit name + directory: formula-name /path/to/dir
 * 2. Directory only (legacy): /path/to/dir
 * 3. Formula name only (legacy): formula-name or formula-name@version
 */
function parseFormulaInputs(formulaName: string, directory?: string): {
  name: string;
  version?: string;
  isDirectory: boolean;
  directoryPath?: string;
  isExplicitPair: boolean;
} {
  // Pattern 1: Explicit name + directory (new functionality)
  if (directory?.startsWith('/')) {
    return {
      name: formulaName,
      isDirectory: true,
      directoryPath: directory,
      isExplicitPair: true
    };
  }

  // Pattern 2: Directory path as first argument (legacy)
  if (formulaName.startsWith('/')) {
    const directoryPath = formulaName;
    const name = basename(directoryPath);

    if (!name) {
      throw new ValidationError(`Invalid directory path: ${formulaName}`);
    }

    return {
      name,
      isDirectory: true,
      directoryPath,
      isExplicitPair: false
    };
  }

  // Pattern 3: Formula name with optional version (legacy)
  const atIndex = formulaName.lastIndexOf('@');

  if (atIndex === -1) {
    return {
      name: formulaName,
      isDirectory: false,
      isExplicitPair: false
    };
  }

  const name = formulaName.substring(0, atIndex);
  const version = formulaName.substring(atIndex + 1);

  if (!name || !version) {
    throw new ValidationError(`Invalid formula syntax: ${formulaName}. Use format: formula@version`);
  }

  return {
    name,
    version,
    isDirectory: false,
    isExplicitPair: false
  };
}


/**
 * Create formula.yml automatically in a directory without user prompts
 * Reuses init command logic but makes it non-interactive
 */
async function createFormulaYmlInDirectory(formulaDir: string, formulaName: string): Promise<{ fullPath: string; config: FormulaYml; isNewFormula: boolean }> {
  const cwd = process.cwd();
  
  // Ensure the target directory exists (including formulas subdirectory)
  await ensureLocalGroundZeroStructure(cwd);
  await ensureDir(formulaDir);
  
  // Create formula.yml in the formula directory (not the main .groundzero directory)
  const formulaYmlPath = join(formulaDir, FILE_PATTERNS.FORMULA_YML);
  
  // Create default formula config
  const formulaConfig: FormulaYml = {
    name: formulaName,
    version: DEFAULT_VERSION
  };
  
  // Create the formula.yml file
  await writeFormulaYml(formulaYmlPath, formulaConfig);
  console.log(`${LOG_PREFIX_CREATED} ${formulaDir}`);
  console.log(`${LOG_PREFIX_NAME} ${formulaConfig.name}`);
  console.log(`${LOG_PREFIX_VERSION} ${formulaConfig.version}`);
  
  return {
    fullPath: formulaYmlPath,
    config: formulaConfig,
    isNewFormula: true
  };
}

/**
 * Handle formula name input for non-existing formulas
 * Checks if formula.yml exists in .groundzero/formulas/<formula-name>/formula.yml and creates it if not
 */
async function handleFormulaNameInput(formulaName: string): Promise<{ fullPath: string; config: FormulaYml; isNewFormula: boolean }> {
  const cwd = process.cwd();
  const formulaDir = getLocalFormulaDir(cwd, formulaName);
  const formulaYmlPath = join(formulaDir, FILE_PATTERNS.FORMULA_YML);

  // Check if formula.yml already exists in .groundzero/formulas/<formula-name>/
  if (await exists(formulaYmlPath)) {
    logger.debug('Found existing formula.yml, parsing...');
    try {
      const formulaConfig = await parseFormulaYml(formulaYmlPath);
      console.log(LOG_PREFIX_FOUND);
      console.log(`${LOG_PREFIX_NAME} ${formulaConfig.name}`);
      console.log(`${LOG_PREFIX_VERSION} ${formulaConfig.version}`);

      return {
        fullPath: formulaYmlPath,
        config: formulaConfig,
        isNewFormula: false
      };
    } catch (error) {
      throw new ValidationError(`Failed to parse existing formula.yml at ${formulaYmlPath}: ${error}`);
    }
  } else {
    logger.debug('No formula.yml found, creating automatically...');
    return await createFormulaYmlInDirectory(formulaDir, formulaName);
  }
}

/**
 * Handle directory-based formula input
 * Creates formula.yml in .groundzero/formulas/<formula-name>/formula.yml
 */
async function handleDirectoryInput(directoryPath: string, formulaName: string): Promise<{ fullPath: string; config: FormulaYml; isNewFormula: boolean }> {
  const cwd = process.cwd();
  const sourceDir = join(cwd, directoryPath.substring(1)); // Remove leading '/'
  const formulaDir = getLocalFormulaDir(cwd, formulaName);
  const formulaYmlPath = join(formulaDir, FILE_PATTERNS.FORMULA_YML);
  
  logger.debug(`Handling directory input: source=${sourceDir}, formula=${formulaDir}`);
  
  // Check if formula.yml already exists in .groundzero/formulas/<formula-name>/
  if (await exists(formulaYmlPath)) {
    logger.debug('Found existing formula.yml, parsing...');
    try {
      const formulaConfig = await parseFormulaYml(formulaYmlPath);
      console.log(LOG_PREFIX_FOUND);
      console.log(`${LOG_PREFIX_NAME} ${formulaConfig.name}`);
      console.log(`${LOG_PREFIX_VERSION} ${formulaConfig.version}`);

      return {
        fullPath: formulaYmlPath,
        config: formulaConfig,
        isNewFormula: false
      };
    } catch (error) {
      throw new ValidationError(`Failed to parse existing formula.yml at ${formulaYmlPath}: ${error}`);
    }
  } else {
    logger.debug('No formula.yml found, creating automatically...');
    return await createFormulaYmlInDirectory(formulaDir, formulaName);
  }
}

/**
 * Recursively find files by extension in a directory
 */
async function findFilesByExtension(
  dir: string, 
  extension: string, 
  baseDir: string = dir
): Promise<Array<{ fullPath: string; relativePath: string }>> {
  if (!(await exists(dir)) || !(await isDirectory(dir))) {
    return [];
  }
  
  const files: Array<{ fullPath: string; relativePath: string }> = [];
  
  // Check current directory files
  const dirFiles = await listFiles(dir);
  for (const file of dirFiles) {
    if (file.endsWith(extension)) {
      const fullPath = join(dir, file);
      const relativePath = fullPath.substring(baseDir.length + 1);
      files.push({ fullPath, relativePath });
    }
  }
  
  // Recursively search subdirectories
  const subdirs = await listDirectories(dir);
  const subFilesPromises = subdirs.map(subdir => 
    findFilesByExtension(join(dir, subdir), extension, baseDir)
  );
  const subFiles = await Promise.all(subFilesPromises);
  files.push(...subFiles.flat());
  
  return files;
}

/**
 * Find all markdown files in a directory
 */
const findAllMarkdownFiles = (dir: string, baseDir: string = dir) =>
  findFilesByExtension(dir, FILE_PATTERNS.MD_FILES, baseDir);


/**
 * Get file modification time
 * @throws Error if unable to get file stats
 */
async function getFileMtime(filePath: string): Promise<number> {
  const stats = await getStats(filePath);
  return stats.mtime.getTime();
}



/**
 * Resolve the source directory based on input pattern and directory path
 * @param directoryPath - The directory path to resolve
 * @param isExplicitPair - Whether this is an explicit name + directory pair
 * @param isDirectory - Whether input was a directory path
 * @returns Promise resolving to the resolved source directory path
 * @throws ValidationError if directory path is required but not provided
 */
async function resolveSourceDirectory(directoryPath: string | undefined, isExplicitPair: boolean, isDirectory: boolean): Promise<string> {
  if (!directoryPath) {
    throw new ValidationError('Directory path is required');
  }

  if (directoryPath.startsWith('/')) {
    const absolutePath = directoryPath;
    const relativePath = join(process.cwd(), directoryPath.substring(1));
    // Use the path that exists, prefer absolute
    if (await exists(absolutePath)) {
      return absolutePath;
    } else if (await exists(relativePath)) {
      return relativePath;
    } else {
      return absolutePath; // Default to absolute
    }
  } else {
    return join(process.cwd(), directoryPath);
  }
}

/**
 * Discover files based on the input pattern (explicit directory, directory mode, or formula name)
 * @param formulaDir - Path to the formula directory
 * @param formulaName - Name of the formula
 * @param isExplicitPair - Whether this is an explicit name + directory pair
 * @param isDirectory - Whether input was a directory path
 * @param directoryPath - The directory path if provided
 * @param sourceDir - The resolved source directory to search in
 * @returns Promise resolving to array of discovered files
 */
async function discoverFilesForPattern(
  formulaDir: string,
  formulaName: string,
  isExplicitPair: boolean,
  isDirectory: boolean,
  directoryPath: string | undefined,
  sourceDir: string
): Promise<DiscoveredFile[]> {
  if ((isExplicitPair || isDirectory) && directoryPath) {
    // Patterns 1 & 2: Directory-based input
    const platformInfo = parsePlatformDirectory(directoryPath);
    if (platformInfo) {
      // Directory is a platform-specific directory, search directly in it
      const registryPathPrefix = platformInfo.relativePath ? join(platformInfo.platform, platformInfo.relativePath) : platformInfo.platform;
      const filePatterns = platformInfo.platformName === (PLATFORM_DIRS.AI as PlatformName) ? [FILE_PATTERNS.MD_FILES] : [...getPlatformDefinition(platformInfo.platformName).filePatterns];
      return discoverFiles(sourceDir, formulaName, platformInfo.platformName, registryPathPrefix, filePatterns, 'directory');
    } else {
      // Directory is a formula root, search for platform subdirectories
      return discoverMdFilesUnified(formulaDir, formulaName, sourceDir, true);
    }
  } else {
    // Pattern 3: Legacy formula name input - use unified discovery from formula directory
    return discoverMdFilesUnified(formulaDir, formulaName);
  }
}

/**
 * Discover markdown files in a directory with specified patterns and inclusion rules
 */
async function discoverFiles(
  directoryPath: string,
  formulaName: string,
  platformName: PlatformName,
  registryPathPrefix: string = '',
  filePatterns: string[] = [FILE_PATTERNS.MD_FILES],
  inclusionMode: 'directory' | 'platform' = 'directory',
  formulaDir?: string
): Promise<DiscoveredFile[]> {
  if (!(await exists(directoryPath)) || !(await isDirectory(directoryPath))) {
    return [];
  }

  // Find files with the specified patterns
  const allFiles: Array<{ fullPath: string; relativePath: string }> = [];
  for (const pattern of filePatterns) {
    const extension = pattern.startsWith('.') ? pattern : `.${pattern}`;
    const files = await findFilesByExtension(directoryPath, extension, directoryPath);
    allFiles.push(...files);
  }

  // Process files in parallel
  const processPromises = allFiles.map(async (file) => {
    try {
      const content = await readTextFile(file.fullPath);
      let frontmatter;
      try {
        frontmatter = parseMarkdownFrontmatter(content);
      } catch (parseError) {
        logger.warn(`Failed to parse frontmatter in ${file.relativePath}: ${parseError}`);
        frontmatter = null;
      }

      const shouldInclude = inclusionMode === 'directory'
        ? shouldIncludeForDirectoryMode(file, frontmatter, formulaName)
        : shouldIncludeForPlatformMode(file, frontmatter, platformName, formulaName, formulaDir, inclusionMode === 'platform');

      if (shouldInclude) {
        // Skip template files
        if (detectTemplateFile(content)) {
          logger.debug(`Skipping template file: ${file.relativePath}`);
          return null;
        }

        try {
          const mtime = await getFileMtime(file.fullPath);
          const contentHash = await calculateFileHash(content);

          // For platform mode, check if file should be universal (has matching frontmatter)
          // Universal files don't get the platform prefix in their registry path
          let registryPath: string;
          if (inclusionMode === 'platform' && platformName !== ('ai' as PlatformName) && frontmatter?.formula?.name === formulaName) {
            // Universal file from platform directory - map into universal subdir (rules/commands/agents)
            // Compute path relative to the scanned directory (rulesDir/commandsDir/agentsDir)
            let relativeFromSourceDir = relative(directoryPath, file.fullPath);
            if (relativeFromSourceDir.startsWith('../')) {
              // Safety fallback if traversal occurs unexpectedly
              relativeFromSourceDir = file.relativePath;
            }
            if (relativeFromSourceDir.endsWith(FILE_PATTERNS.MDC_FILES)) {
              relativeFromSourceDir = relativeFromSourceDir.replace(new RegExp(`\\${FILE_PATTERNS.MDC_FILES}$`), FILE_PATTERNS.MD_FILES);
            }
            registryPath = registryPathPrefix ? join(registryPathPrefix, relativeFromSourceDir) : relativeFromSourceDir;
          } else {
            // Platform-specific file or directory mode - use normal registry path logic
            registryPath = registryPathPrefix ? join(registryPathPrefix, file.relativePath) : file.relativePath;
          }

          const result: DiscoveredFile = {
            fullPath: file.fullPath,
            relativePath: file.relativePath,
            sourceDir: platformName,
            registryPath,
            mtime,
            contentHash
          };

          if (frontmatter?.formula?.platformSpecific === true) {
            result.forcePlatformSpecific = true;
          }

          return result;
        } catch (error) {
          logger.warn(`Failed to process file metadata for ${file.relativePath}: ${error}`);
        }
      }
    } catch (error) {
      logger.warn(`Failed to read ${file.relativePath}: ${error}`);
    }
    return null;
  });

  const results = await Promise.all(processPromises);
  return results.filter((result): result is DiscoveredFile => result !== null);
}

/**
 * Determine if a file should be included in directory mode
 * @param file - File information with relative path
 * @param frontmatter - Parsed frontmatter from the file
 * @param formulaName - Name of the formula to match against
 * @returns true if the file should be included
 */
function shouldIncludeForDirectoryMode(
  file: { relativePath: string },
  frontmatter: any,
  formulaName: string
): boolean {
  // Include files that either:
  // 1. Have no frontmatter (will get frontmatter added)
  // 2. Have matching frontmatter
  // 3. Have no conflicting frontmatter
  return !frontmatter ||
         !frontmatter.formula ||
         frontmatter?.formula?.name === formulaName ||
         !frontmatter?.formula?.name;
}

/**
 * Determine if a file should be included in platform mode
 */
function shouldIncludeForPlatformMode(
  file: { relativePath: string },
  frontmatter: any,
  platformName: PlatformName,
  formulaName: string,
  formulaDir?: string,
  isDirectoryMode?: boolean
): boolean {
  return shouldIncludeMarkdownFile(file, frontmatter, platformName, formulaName, formulaDir, isDirectoryMode);
}

/**
 * Unified file discovery function that searches platform-specific directories
 */
async function discoverMdFilesUnified(formulaDir: string, formulaName: string, baseDir?: string, isDirectoryMode?: boolean): Promise<DiscoveredFile[]> {
  const cwd = baseDir || process.cwd();
  const platformConfigs = await buildPlatformSearchConfig(cwd);
  const allDiscoveredFiles: DiscoveredFile[] = [];

  // Process all platform configurations in parallel
  const processPromises = platformConfigs.map(async (config) => {
    return processPlatformFiles(config, formulaDir, formulaName, isDirectoryMode);
  });

  const results = await Promise.all(processPromises);
  allDiscoveredFiles.push(...results.flat());

  return allDiscoveredFiles;
}

/**
 * Process files for a specific platform configuration
 */
async function processPlatformFiles(
  config: PlatformSearchConfig,
  formulaDir: string,
  formulaName: string,
  isDirectoryMode?: boolean
): Promise<DiscoveredFile[]> {
  const allFiles: DiscoveredFile[] = [];

  // Handle AI directory separately - it's not a platform subdirectory structure
  if (config.name === PLATFORM_DIRS.AI) {
    const aiFiles = await discoverFiles(
      config.rulesDir,
      formulaName,
      config.platform,
      PLATFORM_DIRS.AI, // AI directory uses 'ai' prefix
      config.filePatterns,
      'platform',
      formulaDir
    );
    allFiles.push(...aiFiles);
    return allFiles;
  }

  // Process platform subdirectories with universal registry paths
  // Process rules directory
  if (config.rulesDir) {
    const rulesFiles = await discoverFiles(
      config.rulesDir,
      formulaName,
      config.platform,
      PLATFORM_SUBDIRS.RULES, // Universal registry path for rules
      config.filePatterns,
      'platform',
      formulaDir
    );
    allFiles.push(...rulesFiles);
  }

  // Process commands directory if available
  if (config.commandsDir) {
    const commandFiles = await discoverFiles(
      config.commandsDir,
      formulaName,
      config.platform,
      PLATFORM_SUBDIRS.COMMANDS, // Universal registry path for commands
      config.filePatterns,
      'platform',
      formulaDir
    );
    allFiles.push(...commandFiles);
  }

  // Process agents directory if available
  if (config.agentsDir) {
    const agentFiles = await discoverFiles(
      config.agentsDir,
      formulaName,
      config.platform,
      PLATFORM_SUBDIRS.AGENTS, // Universal registry path for agents
      config.filePatterns,
      'platform',
      formulaDir
    );
    allFiles.push(...agentFiles);
  }

  return allFiles;
}


/**
 * Determine if a markdown file should be included based on frontmatter rules
 */
function shouldIncludeMarkdownFile(
  mdFile: { relativePath: string },
  frontmatter: any,
  sourceDir: string,
  formulaName: string,
  formulaDirRelativeToAi?: string,
  isDirectoryMode?: boolean
): boolean {
  const mdFileDir = dirname(mdFile.relativePath);

  // For AI directory: include files adjacent to formula.yml or with matching frontmatter
  if (sourceDir === PLATFORM_DIRS.AI) {
    if (frontmatter?.formula?.name === formulaName) {
      logger.debug(`Including ${mdFile.relativePath} from ai (matches formula name in frontmatter)`);
      return true;
    }

    // For directory mode, skip the "adjacent to formula.yml" check since there's no formula.yml in source
    if (!isDirectoryMode && mdFileDir === formulaDirRelativeToAi && (!frontmatter || !frontmatter.formula)) {
      logger.debug(`Including ${mdFile.relativePath} from ai (adjacent to formula.yml, no conflicting frontmatter)`);
      return true;
    }

    // For directory mode, include files without conflicting frontmatter
    if (isDirectoryMode && (!frontmatter || !frontmatter.formula || frontmatter.formula.name === formulaName)) {
      logger.debug(`Including ${mdFile.relativePath} from ai (directory mode, no conflicting frontmatter)`);
      return true;
    }

    if (frontmatter?.formula?.name && frontmatter.formula.name !== formulaName) {
      logger.debug(`Skipping ${mdFile.relativePath} from ai (frontmatter specifies different formula: ${frontmatter.formula.name})`);
    } else {
      logger.debug(`Skipping ${mdFile.relativePath} from ai (not adjacent to formula.yml and no matching frontmatter)`);
    }
    return false;
  }

  // For command directories: only include files with matching frontmatter
  if (frontmatter?.formula?.name === formulaName) {
    logger.debug(`Including ${mdFile.relativePath} from ${sourceDir} (matches formula name in frontmatter)`);
    return true;
  }

  // For directory mode in platform directories, include files without conflicting frontmatter
  if (isDirectoryMode && (!frontmatter || !frontmatter.formula || frontmatter.formula.name === formulaName)) {
    logger.debug(`Including ${mdFile.relativePath} from ${sourceDir} (directory mode, no conflicting frontmatter)`);
    return true;
  }

  logger.debug(`Skipping ${mdFile.relativePath} from ${sourceDir} (no matching frontmatter)`);
  return false;
}



/**
 * Find formula.yml files with the specified formula name
 * Searches in both .groundzero/formulas directory
 * Also scans for files with matching frontmatter
 */
async function findFormulaYmlByName(formulaName: string): Promise<Array<{ fullPath: string; relativePath: string; config: FormulaYml }>> {
  const cwd = process.cwd();
  const matchingFormulas: Array<{ fullPath: string; relativePath: string; config: FormulaYml }> = [];
  
  // Search in .groundzero/formulas directory
  const formulasDir = getLocalFormulasDir(cwd);
  if (await exists(formulasDir) && await isDirectory(formulasDir)) {
    const formulaDirs = await listDirectories(formulasDir);
    
    // Process formula directories in parallel
    const formulaPromises = formulaDirs.map(async (formulaDir) => {
      const formulaYmlPath = join(formulasDir, formulaDir, FILE_PATTERNS.FORMULA_YML);
      if (await exists(formulaYmlPath)) {
        try {
          const config = await parseFormulaYml(formulaYmlPath);
          if (config.name === formulaName) {
            return {
              fullPath: formulaYmlPath,
              relativePath: join(PLATFORM_DIRS.GROUNDZERO, FORMULA_DIRS.FORMULAS, formulaDir, FILE_PATTERNS.FORMULA_YML),
              config
            };
          }
        } catch (error) {
          logger.warn(`Failed to parse formula.yml at ${formulaYmlPath}: ${error}`);
        }
      }
      return null;
    });

    const formulaResults = await Promise.all(formulaPromises);
    matchingFormulas.push(...formulaResults.filter((result): result is { fullPath: string; relativePath: string; config: FormulaYml } => result !== null));
  }
  
  
  // Scan for files with matching frontmatter
  const frontmatterMatches = await findFormulasByFrontmatter(formulaName);
  matchingFormulas.push(...frontmatterMatches);
  
  // Deduplicate results based on fullPath to avoid duplicates
  const uniqueFormulas = new Map<string, { fullPath: string; relativePath: string; config: FormulaYml }>();
  
  for (const formula of matchingFormulas) {
    if (!uniqueFormulas.has(formula.fullPath)) {
      uniqueFormulas.set(formula.fullPath, formula);
    }
  }
  
  return Array.from(uniqueFormulas.values());
}

/**
 * Find formulas by scanning markdown files for matching frontmatter
 * Only checks /ai directory and platform-specific rules/commands/agents directories
 */
async function findFormulasByFrontmatter(formulaName: string): Promise<Array<{ fullPath: string; relativePath: string; config: FormulaYml }>> {
  const cwd = process.cwd();
  const matchingFormulas: Array<{ fullPath: string; relativePath: string; config: FormulaYml }> = [];
  
  // Helper function to process markdown files in a directory
  const processMarkdownFiles = async (
    dirPath: string, 
    registryPath: string, 
    sourceName: string
  ): Promise<void> => {
    if (!(await exists(dirPath)) || !(await isDirectory(dirPath))) {
      return;
    }
    
    const allMdFiles = await findAllMarkdownFiles(dirPath);

    // Process markdown files in parallel
    const filePromises = allMdFiles.map(async (mdFile) => {
      try {
        const content = await readTextFile(mdFile.fullPath);
        const frontmatter = parseMarkdownFrontmatter(content);

        if (frontmatter?.formula?.name === formulaName) {
          // Create a virtual formula.yml config based on frontmatter
          const config: FormulaYml = {
            name: formulaName,
            version: DEFAULT_VERSION // Default version for frontmatter-based formulas
          };

          return {
            fullPath: mdFile.fullPath, // Use the markdown file as the "formula" location
            relativePath: registryPath ? join(registryPath, mdFile.relativePath) : mdFile.relativePath,
            config
          };
        }
      } catch (error) {
        logger.warn(`Failed to read or parse ${mdFile.relativePath} from ${sourceName}: ${error}`);
      }
      return null;
    });

    const fileResults = await Promise.all(filePromises);
    matchingFormulas.push(...fileResults.filter((result): result is { fullPath: string; relativePath: string; config: FormulaYml } => result !== null));
  };
  
  // Search in AI directory for markdown files with matching frontmatter
  const aiDir = join(cwd, PLATFORM_DIRS.AI);
  await processMarkdownFiles(aiDir, '', PLATFORM_DIRS.AI);
  
  // Search in platform-specific directories (rules, commands, agents)
  const platformConfigs = await buildPlatformSearchConfig(cwd);
  
  for (const config of platformConfigs) {
    // Skip AI directory since it's handled above
    if (config.name === PLATFORM_DIRS.AI) {
      continue;
    }
    
    // Check rules directory
    if (config.rulesDir) {
      await processMarkdownFiles(config.rulesDir, config.registryPath, config.name);
    }
    
    // Check commands directory
    if (config.commandsDir) {
      await processMarkdownFiles(
        config.commandsDir, 
        join(config.registryPath, PLATFORM_SUBDIRS.COMMANDS), 
        config.name
      );
    }
    
    // Check agents directory
    if (config.agentsDir) {
      await processMarkdownFiles(
        config.agentsDir, 
        join(config.registryPath, PLATFORM_SUBDIRS.AGENTS), 
        config.name
      );
    }
  }
  
  return matchingFormulas;
}

/**
 * Main implementation of the save formula command
 * Handles three usage patterns: explicit name+directory, directory-only, and formula name
 * @param formulaName - Formula name or directory path
 * @param directory - Optional directory path when using explicit name+directory pattern
 * @param versionType - Optional version type ('stable')
 * @param options - Command options (force, bump, etc.)
 * @returns Promise resolving to command result
 */
async function saveFormulaCommand(
  formulaName: string,
  directory?: string,
  versionType?: string,
  options?: SaveOptions
): Promise<CommandResult> {
  const cwd = process.cwd();

  // Parse inputs to determine the pattern being used
  const { name, version: explicitVersion, isDirectory, directoryPath, isExplicitPair } = parseFormulaInputs(formulaName, directory);

  logger.debug(`Saving formula with name: ${name}`, { explicitVersion, isDirectory, directoryPath, isExplicitPair, options });
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  // Ensure main formula.yml exists for the codebase
  const newFormulaYml = await createBasicFormulaYml(cwd);
  
  let formulaInfo: { fullPath: string; config: FormulaYml; isNewFormula: boolean };

  if (isExplicitPair && directoryPath) {
    // Pattern 1: Explicit name + directory - formula.yml in .groundzero/formulas/<name>/
    formulaInfo = await handleFormulaNameInput(name);
  } else if (isDirectory && directoryPath && !isExplicitPair) {
    // Pattern 2: Legacy directory input - formula.yml in the source directory
    formulaInfo = await handleDirectoryInput(directoryPath, name);
  } else {
    // Pattern 3: Legacy formula name input - formula.yml in .groundzero/formulas/<name>/
    formulaInfo = await handleFormulaNameInput(name);
  }

  const formulaDir = dirname(formulaInfo.fullPath);
  const formulaYmlPath = formulaInfo.fullPath;
  let formulaConfig = formulaInfo.config;

  logger.debug(`Found formula.yml at: ${formulaYmlPath}`);

  // Determine target version
  const targetVersion = await determineTargetVersion(explicitVersion, versionType, options, formulaInfo.isNewFormula ? undefined : formulaConfig.version);

  // Check if version already exists (unless force is used)
  if (!options?.force) {
    const versionExists = await hasFormulaVersion(name, targetVersion);
    if (versionExists) {
      throw new Error(`Version ${targetVersion} already exists. Use --force to overwrite.`);
    }
  }

  // Update formula config with new version
  formulaConfig = { ...formulaConfig, version: targetVersion };

  // Determine source directory for file discovery
  const sourceDir = (isExplicitPair || isDirectory) && directoryPath
    ? await resolveSourceDirectory(directoryPath, isExplicitPair, isDirectory)
    : formulaDir;

  // Discover and include MD files using appropriate logic
  const discoveredFiles = await discoverFilesForPattern(formulaDir, formulaConfig.name, isExplicitPair, isDirectory, directoryPath, sourceDir);
  console.log(`${LOG_PREFIX_FILES} ${discoveredFiles.length} ${LOG_PREFIX_FILES_SUFFIX}`);
  
  // Resolve file conflicts (keep latest mtime)
  const resolvedFiles = await resolveFileConflicts(discoveredFiles, targetVersion);
  if (resolvedFiles.length !== discoveredFiles.length) {
    console.log(`${LOG_PREFIX_RESOLVED} ${resolvedFiles.length} files`);
  }
  
  // Create formula files array
  const formulaFiles = await createFormulaFilesUnified(formulaYmlPath, formulaConfig, resolvedFiles);
  
  // Save formula to local registry
  const saveResult = await saveFormulaToRegistry(formulaConfig, formulaFiles, formulaYmlPath, options?.force);
  
  if (!saveResult.success) {
    return { success: false, error: saveResult.error || 'Failed to save formula' };
  }
  
  // Add saved formula to main formula.yml dependencies
  await addFormulaToYml(cwd, formulaConfig.name, formulaConfig.version);
  
  console.log(`${LOG_PREFIX_SAVED} ${formulaConfig.name}@${formulaConfig.version} (${formulaFiles.length} files)`);
  return { success: true, data: formulaConfig };
}


/**
 * Discover MD files based on new frontmatter rules from multiple directories
 */


/**
 * Create formula files array with unified discovery results
 */
async function createFormulaFilesUnified(
  formulaYmlPath: string,
  formulaConfig: FormulaYml,
  discoveredFiles: DiscoveredFile[]
): Promise<FormulaFile[]> {
  const formulaFiles: FormulaFile[] = [];

  // Add formula.yml as the first file
  await writeFormulaYml(formulaYmlPath, formulaConfig);
  // Reuse the formula config content instead of reading the file again
  const updatedFormulaYmlContent = await readTextFile(formulaYmlPath);
  formulaFiles.push({
    path: FILE_PATTERNS.FORMULA_YML,
    content: updatedFormulaYmlContent,
    isTemplate: false,
    encoding: UTF8_ENCODING
  });

  // Process discovered MD files in parallel
  const mdFilePromises = discoveredFiles.map(async (mdFile) => {
    const originalContent = await readTextFile(mdFile.fullPath);
    const updatedContent = updateMarkdownWithFormulaFrontmatter(originalContent, formulaConfig.name);

    // Update source file if content changed
    if (updatedContent !== originalContent) {
      await writeTextFile(mdFile.fullPath, updatedContent);
      console.log(`${LOG_PREFIX_UPDATED} ${mdFile.relativePath}`);
    }

    return {
      path: mdFile.registryPath,
      content: updatedContent,
      isTemplate: detectTemplateFile(updatedContent),
      encoding: UTF8_ENCODING
    };
  });

  const processedMdFiles = await Promise.all(mdFilePromises);
  formulaFiles.push(...processedMdFiles);
  
  return formulaFiles;
}


/**
 * Handle explicit version input from user
 * @param explicitVersion - The version string provided by the user
 * @returns The explicit version string
 */
function handleExplicitVersion(explicitVersion: string): string {
  console.log(`${LOG_PREFIX_EXPLICIT_VERSION} ${explicitVersion}`);
  return explicitVersion;
}

/**
 * Handle new formula with no current version
 */
function handleNewFormula(): string {
  const prereleaseVersion = generateLocalVersion(DEFAULT_VERSION);
  console.log(`${LOG_PREFIX_PRERELEASE} ${prereleaseVersion}`);
  return prereleaseVersion;
}

/**
 * Handle bump operations
 */
function handleBumpOperation(currentVersion: string, versionType: string | undefined, bumpType: 'patch' | 'minor' | 'major'): string {
  if (versionType === VERSION_TYPE_STABLE) {
    const bumpedVersion = bumpToStable(currentVersion, bumpType);
    console.log(`${LOG_PREFIX_BUMP_STABLE} ${currentVersion} ${ARROW_SEPARATOR} ${bumpedVersion}`);
    return bumpedVersion;
  } else {
    const bumpedVersion = bumpToPrerelease(currentVersion, bumpType);
    console.log(`${LOG_PREFIX_BUMP_PRERELEASE} ${currentVersion} ${ARROW_SEPARATOR} ${bumpedVersion}`);
    return bumpedVersion;
  }
}

/**
 * Handle stable conversion
 */
async function handleStableConversion(currentVersion: string, options?: SaveOptions): Promise<string> {
  if (isPrerelease(currentVersion)) {
    const stableVersion = convertPrereleaseToStable(currentVersion);
    console.log(`${LOG_PREFIX_CONVERT_STABLE} ${currentVersion} ${ARROW_SEPARATOR} ${stableVersion}`);
    return stableVersion;
  } else {
    // Already stable - prompt for confirmation
    console.log(`${LOG_PREFIX_WARNING} ${currentVersion} ${LOG_PREFIX_WARNING_SUFFIX}`);
    if (!options?.force) {
      const shouldOverwrite = await promptConfirmation(
        `Overwrite existing stable version ${currentVersion}?`,
        false
      );
      if (!shouldOverwrite) {
        throw new Error('Operation cancelled by user');
      }
    }
    console.log(`${LOG_PREFIX_OVERWRITE_STABLE} ${currentVersion}`);
    return currentVersion;
  }
}

/**
 * Handle default smart increment behavior
 */
function handleSmartIncrement(currentVersion: string): string {
  if (isPrerelease(currentVersion)) {
    const localVersion = generateLocalVersion(extractBaseVersion(currentVersion));
    console.log(`${LOG_PREFIX_INCREMENT_PRERELEASE} ${currentVersion} ${ARROW_SEPARATOR} ${localVersion}`);
    return localVersion;
  } else {
    // For other stable versions, bump patch and then generate prerelease
    const nextPatchVersion = calculateBumpedVersion(currentVersion, 'patch');
    const localVersion = generateLocalVersion(nextPatchVersion);
    console.log(`${LOG_PREFIX_AUTO_INCREMENT} ${currentVersion} ${ARROW_SEPARATOR} ${localVersion}`);
    return localVersion;
  }
}

/**
 * Determine target version based on input, version type, and options
 */
async function determineTargetVersion(
  explicitVersion?: string,
  versionType?: string,
  options?: SaveOptions,
  currentVersion?: string
): Promise<string> {
  if (explicitVersion) {
    return handleExplicitVersion(explicitVersion);
  }

  if (!currentVersion) {
    return handleNewFormula();
  }

  if (options?.bump) {
    return handleBumpOperation(currentVersion, versionType, options.bump);
  }

  if (versionType === VERSION_TYPE_STABLE) {
    return handleStableConversion(currentVersion, options);
  }

  return handleSmartIncrement(currentVersion);
}

/**
 * Convert a prerelease version to stable version
 * Example: "1.2.3-dev.abc" -> "1.2.3"
 */
function convertPrereleaseToStable(version: string): string {
  return extractBaseVersion(version);
}

/**
 * Check if a version is a prerelease version
 */
function isPrerelease(version: string): boolean {
  return isLocalVersion(version);
}

/**
 * Bump version to prerelease (default behavior for --bump)
 */
function bumpToPrerelease(version: string, bumpType: 'patch' | 'minor' | 'major'): string {
  const baseVersion = extractBaseVersion(version);
  const bumpedBase = calculateBumpedVersion(baseVersion, bumpType);
  return generateLocalVersion(bumpedBase);
}

/**
 * Bump version to stable (when combined with 'stable' argument)
 */
function bumpToStable(version: string, bumpType: 'patch' | 'minor' | 'major'): string {
  const baseVersion = extractBaseVersion(version);
  return calculateBumpedVersion(baseVersion, bumpType);
}

/**
 * Calculate bumped version based on type (stable output)
 */
function calculateBumpedVersion(version: string, bumpType: 'patch' | 'minor' | 'major'): string {
  // Extract base version (remove any prerelease identifiers and build metadata)
  const baseVersion = version.split('-')[0].split('+')[0];
  const parts = baseVersion.split('.').map(Number);

  // Validate that we have valid numbers
  if (parts.some(isNaN)) {
    throw new ValidationError(`Invalid version format: ${version}`);
  }

  switch (bumpType) {
    case 'patch':
      return parts.length >= 3 ? `${parts[0]}.${parts[1]}.${parts[2] + 1}` : baseVersion;
    case 'minor':
      return parts.length >= 2 ? `${parts[0]}.${parts[1] + 1}.0` : baseVersion;
    case 'major':
      return parts.length >= 1 ? `${parts[0] + 1}.0.0` : baseVersion;
    default:
      throw new ValidationError(`Invalid bump type: ${bumpType}. Must be 'patch', 'minor', or 'major'.`);
  }
}


/**
 * Save formula to local registry
 */
async function saveFormulaToRegistry(
  config: FormulaYml, 
  files: FormulaFile[], 
  formulaYmlPath: string,
  force?: boolean
): Promise<{ success: boolean; error?: string; updatedConfig?: FormulaYml }> {
  try {
    const targetPath = getFormulaVersionPath(config.name, config.version);
    await ensureDir(targetPath);
    
    // Group files by target directory
    const directoryGroups = new Map<string, FormulaFile[]>();
    
    for (const file of files) {
      const targetDir = getTargetDirectory(targetPath, file.path);
      if (!directoryGroups.has(targetDir)) {
        directoryGroups.set(targetDir, []);
      }
      directoryGroups.get(targetDir)!.push(file);
    }
    
    // Save files in parallel by directory
    const savePromises = Array.from(directoryGroups.entries()).map(async ([dir, dirFiles]) => {
      await ensureDir(dir);
      
      const filePromises = dirFiles.map(async (file) => {
        const filePath = getTargetFilePath(dir, file.path);
        await writeTextFile(filePath, file.content, file.encoding as BufferEncoding || UTF8_ENCODING);
      });
      
      await Promise.all(filePromises);
    });
    
    await Promise.all(savePromises);
    
    logger.info(`Formula '${config.name}@${config.version}' saved to local registry`);
    return { success: true, updatedConfig: config };
  } catch (error) {
    logger.error(`Failed to save formula: ${error}`);
    return { success: false, error: `Failed to save formula: ${error}` };
  }
}


/**
 * Setup the save command
 */
export function setupSaveCommand(program: Command): void {
  program
    .command('save')
    .argument('<formula-name>', 'formula name or directory path (/path/to/dir)')
    .argument('[directory]', 'directory path to save from (optional, /path/to/dir)')
    .argument('[version-type]', 'version type: stable (optional)')
    .description('Save a formula to local registry. \n' +
      'Usage patterns:\n' +
      '  g0 save <formula-name> <directory>    # Save MD files from directory to named formula\n' +
      '  g0 save <formula-name>                # Save MD files for existing formula\n' +
      '  g0 save /path/to/dir                  # Save directory as formula (auto-named)\n' +
      'Auto-generates local dev versions by default.')
    .option('-f, --force', 'overwrite existing version or skip confirmations')
    .option('-b, --bump <type>', `bump version (patch|minor|major). Creates prerelease by default, stable when combined with "${VERSION_TYPE_STABLE}" argument`)
    .action(withErrorHandling(async (formulaName: string, directory?: string, versionType?: string, options?: SaveOptions) => {
      // Smart argument detection: directories always start with "/", version types don't
      let actualDirectory = directory;
      let actualVersionType = versionType;

      if (directory && !directory.startsWith('/')) {
        // Directory argument doesn't start with "/", so it might be a version type
        if (directory === 'stable' && !versionType) {
          actualVersionType = directory;
          actualDirectory = undefined;
        }
        // Future: Add other version types here if needed
      }

      // Validate version type argument
      if (actualVersionType && actualVersionType !== VERSION_TYPE_STABLE) {
        throw new ValidationError(`Invalid version type: ${actualVersionType}. Only '${VERSION_TYPE_STABLE}' is supported.`);
      }

      const result = await saveFormulaCommand(formulaName, actualDirectory, actualVersionType, options);
      if (!result.success) {
        throw new Error(result.error || 'Save operation failed');
      }
    }));
}
