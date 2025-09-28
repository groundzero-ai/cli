import { Command } from 'commander';
import { join, dirname, basename } from 'path';
import { SaveOptions, CommandResult, FormulaYml, FormulaFile, FormulaDependency } from '../types/index.js';
import { parseFormulaYml, writeFormulaYml, parseMarkdownFrontmatter, updateMarkdownWithFormulaFrontmatter } from '../utils/formula-yml.js';
import { detectTemplateFile } from '../utils/template.js';
import { ensureRegistryDirectories, getFormulaVersionPath, hasFormulaVersion } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, FormulaNotFoundError, ValidationError } from '../utils/errors.js';
import { getLocalGroundZeroDir, getLocalFormulaYmlPath, getLocalFormulasDir, getLocalFormulaDir } from '../utils/paths.js';
import { ensureLocalGroundZeroStructure, createBasicFormulaYml, addFormulaToYml } from '../utils/formula-management.js';
import { FILE_PATTERNS, PLATFORMS, PLATFORM_DIRS, PLATFORM_SUBDIRS, DEPENDENCY_ARRAYS, type Platform } from '../constants/index.js';

import { generateLocalVersion, isLocalVersion, extractBaseVersion } from '../utils/version-generator.js';
import { promptConfirmation } from '../utils/prompts.js';
import { calculateFileHash } from '../utils/hash-utils.js';
import { getPlatformNameFromSource, getTargetDirectory, getTargetFilePath } from '../utils/platform-utils.js';
import { resolveFileConflicts } from '../utils/conflict-resolution.js';
import {
  detectAllPlatforms,
  getDetectedPlatforms,
  getPlatformDefinition,
  getPlatformDirectoryPaths,
  type PlatformName
} from '../core/platforms.js';
import type { DiscoveredFile, ContentAnalysisResult } from '../types/index.js';
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

// Constants are imported from shared constants file
const MARKDOWN_EXTENSION = '.md';
const UTF8_ENCODING = 'utf8' as const;

/**
 * Parse a directory path to determine if it's a platform-specific directory
 */
function parsePlatformDirectory(directoryPath: string): { platform: string; relativePath: string; platformName: PlatformName } | null {
  const normalizedPath = directoryPath.replace(/\\/g, '/'); // Normalize for cross-platform

  // Check for AI directory (both absolute and relative paths)
  if (normalizedPath.includes('/ai/') || normalizedPath.startsWith('ai/') || normalizedPath === '/ai' || normalizedPath === 'ai' || normalizedPath.endsWith('/ai')) {
    let aiIndex = normalizedPath.indexOf('/ai/');
    if (aiIndex === -1) {
      aiIndex = normalizedPath.indexOf('ai/');
    }
    if (aiIndex !== -1) {
      const relativePath = normalizedPath.substring(aiIndex + 3); // Remove 'ai' or '/ai'
      return { platform: 'ai', relativePath: relativePath.startsWith('/') ? relativePath.substring(1) : relativePath, platformName: 'ai' as PlatformName };
    }
    if (normalizedPath === '/ai' || normalizedPath === 'ai' || normalizedPath.endsWith('/ai')) {
      return { platform: 'ai', relativePath: '', platformName: 'ai' as PlatformName };
    }
  }

  // Check for other platforms (both absolute and relative paths)
  const platforms = Object.values(PLATFORMS) as PlatformName[];
  for (const platform of platforms) {
    if (platform === ('ai' as PlatformName)) continue; // Already handled above

    const platformDir = PLATFORM_DIRS[platform as keyof typeof PLATFORM_DIRS];

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

    if (normalizedPath === `/${platformDir}` || normalizedPath === platformDir || normalizedPath.endsWith(`/${platformDir}`)) {
      return { platform, relativePath: '', platformName: platform };
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
    name: 'ai',
    platform: 'ai' as PlatformName, // Special case for AI directory
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
      registryPath: platform
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
    version: '0.1.0'
  };
  
  // Create the formula.yml file
  await writeFormulaYml(formulaYmlPath, formulaConfig);
  console.log(`✓ Created formula.yml in ${formulaDir}`);
  console.log(`📦 Name: ${formulaConfig.name}`);
  console.log(`📦 Version: ${formulaConfig.version}`);
  
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
      console.log(`✓ Found existing formula.yml`);
      console.log(`📦 Name: ${formulaConfig.name}`);
      console.log(`📦 Version: ${formulaConfig.version}`);

      return {
        fullPath: formulaYmlPath,
        config: formulaConfig,
        isNewFormula: false
      };
    } catch (error) {
      throw new Error(`Failed to parse existing formula.yml at ${formulaYmlPath}: ${error}`);
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
      console.log(`✓ Found existing formula.yml`);
      console.log(`📦 Name: ${formulaConfig.name}`);
      console.log(`📦 Version: ${formulaConfig.version}`);

      return {
        fullPath: formulaYmlPath,
        config: formulaConfig,
        isNewFormula: false
      };
    } catch (error) {
      throw new Error(`Failed to parse existing formula.yml at ${formulaYmlPath}: ${error}`);
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
  findFilesByExtension(dir, MARKDOWN_EXTENSION, baseDir);

/**
 * Find all formula.yml files in a directory
 */
const findAllFormulaYmlFiles = (dir: string, baseDir: string = dir) => 
  findFilesByExtension(dir, FILE_PATTERNS.FORMULA_YML, baseDir);

/**
 * Get file modification time
 */
async function getFileMtime(filePath: string): Promise<number> {
  try {
    const stats = await getStats(filePath);
    return stats.mtime.getTime();
  } catch (error) {
    logger.warn(`Failed to get mtime for ${filePath}: ${error}`);
    return 0;
  }
}



/**
 * Discover markdown files in a specific directory (for directory input)
 */
async function discoverMdFilesInDirectory(
  directoryPath: string,
  formulaName: string,
  platformName: PlatformName = 'ai' as PlatformName,
  registryPathPrefix: string = ''
): Promise<DiscoveredFile[]> {
  // Get the appropriate file patterns for the platform
  const filePatterns = platformName === ('ai' as PlatformName) ? [MARKDOWN_EXTENSION] : getPlatformDefinition(platformName).filePatterns;

  // Find files with the appropriate patterns
  const allFiles: Array<{ fullPath: string; relativePath: string }> = [];
  for (const pattern of filePatterns) {
    const extension = pattern.startsWith('.') ? pattern : `.${pattern}`;
    const files = await findFilesByExtension(directoryPath, extension, directoryPath);
    allFiles.push(...files);
  }

  const allDiscoveredFiles: DiscoveredFile[] = [];

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

      // For directory input, include files that either:
      // 1. Have no frontmatter (will get frontmatter added)
      // 2. Have matching frontmatter
      // 3. Have no conflicting frontmatter
      const shouldInclude = !frontmatter ||
                           !frontmatter.formula ||
                           frontmatter?.formula?.name === formulaName ||
                           !frontmatter?.formula?.name;

      if (shouldInclude) {
        const mtime = await getFileMtime(file.fullPath);
        const contentHash = await calculateFileHash(content);
        const registryPath = registryPathPrefix ? join(registryPathPrefix, file.relativePath) : file.relativePath;
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
 * Unified file discovery function that searches platform-specific directories
 */
async function discoverMdFilesUnified(formulaDir: string, formulaName: string, baseDir?: string, isDirectoryMode?: boolean): Promise<DiscoveredFile[]> {
  const cwd = baseDir || process.cwd();
  const platformConfigs = await buildPlatformSearchConfig(cwd);
  const allDiscoveredFiles: DiscoveredFile[] = [];

  // Process all platform configurations in parallel
  const processPromises = platformConfigs.map(async (config) => {
    const files = await processPlatformFiles(config, formulaDir, formulaName, isDirectoryMode);
    return files;
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

  // Process rules directory
  if (config.rulesDir) {
    const rulesFiles = await processDirectoryFiles(
      config.rulesDir,
      config.name,
      formulaName,
      config.registryPath || config.name, // Use config.name if registryPath is empty (for AI)
      formulaDir,
      config.filePatterns,
      isDirectoryMode
    );
    allFiles.push(...rulesFiles);
  }

  // Process commands directory if available
  if (config.commandsDir) {
    const commandFiles = await processDirectoryFiles(
      config.commandsDir,
      config.name,
      formulaName,
      join(config.registryPath, PLATFORM_SUBDIRS.COMMANDS),
      formulaDir,
      config.filePatterns,
      isDirectoryMode
    );
    allFiles.push(...commandFiles);
  }

  // Process agents directory if available
  if (config.agentsDir) {
    const agentFiles = await processDirectoryFiles(
      config.agentsDir,
      config.name,
      formulaName,
      join(config.registryPath, PLATFORM_SUBDIRS.AGENTS),
      formulaDir,
      config.filePatterns,
      isDirectoryMode
    );
    allFiles.push(...agentFiles);
  }

  return allFiles;
}

/**
 * Process markdown files from a directory with unified logic
 */
async function processMarkdownFilesUnified(
  dirPath: string,
  sourceDirName: string,
  formulaName: string,
  registryPath: string,
  formulaDir: string,
  filePatterns?: string[],
  isDirectoryMode?: boolean
): Promise<DiscoveredFile[]> {
  return processDirectoryFiles(dirPath, sourceDirName, formulaName, registryPath, formulaDir, filePatterns, isDirectoryMode);
}

/**
 * Process a single markdown file to extract discovered file information
 */
async function processMarkdownFile(
  mdFile: { fullPath: string; relativePath: string },
  sourceDirName: string,
  formulaName: string,
  registryPath: string,
  formulaDir: string,
  isDirectoryMode?: boolean
): Promise<DiscoveredFile | null> {
  try {
    const content = await readTextFile(mdFile.fullPath);
    const frontmatter = parseMarkdownFrontmatter(content);

    if (shouldIncludeMarkdownFileUnified(mdFile, frontmatter, sourceDirName, formulaName, formulaDir, isDirectoryMode)) {
      const mtime = await getFileMtime(mdFile.fullPath);
      const targetRegistryPath = getRegistryPathUnified(registryPath, mdFile.relativePath, sourceDirName);
      const contentHash = await calculateFileHash(content);
      const forcePlatformSpecific = frontmatter?.formula?.platformSpecific === true;

      return {
        fullPath: mdFile.fullPath,
        relativePath: mdFile.relativePath,
        sourceDir: sourceDirName,
        registryPath: targetRegistryPath,
        mtime,
        contentHash,
        forcePlatformSpecific
      };
    }
  } catch (error) {
    logger.warn(`Failed to read or parse ${mdFile.relativePath} from ${sourceDirName}: ${error}`);
  }
  return null;
}

/**
 * Process files in a directory using platform-specific logic
 */
async function processDirectoryFiles(
  dirPath: string,
  sourceDirName: string,
  formulaName: string,
  registryPath: string,
  formulaDir: string,
  filePatterns: string[] = [MARKDOWN_EXTENSION],
  isDirectoryMode?: boolean
): Promise<DiscoveredFile[]> {
  if (!(await exists(dirPath)) || !(await isDirectory(dirPath))) {
    return [];
  }

  // Find files with the specified patterns
  const allFiles: Array<{ fullPath: string; relativePath: string }> = [];
  for (const pattern of filePatterns) {
    const extension = pattern.startsWith('.') ? pattern : `.${pattern}`;
    const files = await findFilesByExtension(dirPath, extension, dirPath);
    allFiles.push(...files);
  }

  // Process files in parallel
  const processPromises = allFiles.map(file =>
    processMarkdownFile(file, sourceDirName, formulaName, registryPath, formulaDir, isDirectoryMode)
  );

  const results = await Promise.all(processPromises);
  return results.filter((result): result is DiscoveredFile => result !== null);
}

/**
 * Determine if a markdown file should be included based on unified frontmatter rules
 */
function shouldIncludeMarkdownFileUnified(
  mdFile: { relativePath: string },
  frontmatter: any,
  sourceDirName: string,
  formulaName: string,
  formulaDir?: string,
  isDirectoryMode?: boolean
): boolean {
  return shouldIncludeMarkdownFile(mdFile, frontmatter, sourceDirName, formulaName, formulaDir, isDirectoryMode);
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
 * Get registry path for a file based on unified directory structure
 */
function getRegistryPathUnified(registryPath: string, relativePath: string, sourceDirName: string): string {
  // Preserve subdirectory structure for ALL directories
  return join(registryPath, relativePath);
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
    
    for (const formulaDir of formulaDirs) {
      const formulaYmlPath = join(formulasDir, formulaDir, FILE_PATTERNS.FORMULA_YML);
      if (await exists(formulaYmlPath)) {
        try {
          const config = await parseFormulaYml(formulaYmlPath);
          if (config.name === formulaName) {
            matchingFormulas.push({
              fullPath: formulaYmlPath,
              relativePath: join('.groundzero', 'formulas', formulaDir, FILE_PATTERNS.FORMULA_YML),
              config
            });
          }
        } catch (error) {
          logger.warn(`Failed to parse formula.yml at ${formulaYmlPath}: ${error}`);
        }
      }
    }
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
    
    for (const mdFile of allMdFiles) {
      try {
        const content = await readTextFile(mdFile.fullPath);
        const frontmatter = parseMarkdownFrontmatter(content);
        
        if (frontmatter?.formula?.name === formulaName) {
          // Create a virtual formula.yml config based on frontmatter
          const config: FormulaYml = {
            name: formulaName,
            version: '0.1.0' // Default version for frontmatter-based formulas
          };
          
          matchingFormulas.push({
            fullPath: mdFile.fullPath, // Use the markdown file as the "formula" location
            relativePath: registryPath ? join(registryPath, mdFile.relativePath) : mdFile.relativePath,
            config
          });
        }
      } catch (error) {
        logger.warn(`Failed to read or parse ${mdFile.relativePath} from ${sourceName}: ${error}`);
      }
    }
  };
  
  // Search in AI directory for markdown files with matching frontmatter
  const aiDir = join(cwd, PLATFORM_DIRS.AI);
  await processMarkdownFiles(aiDir, '', 'ai');
  
  // Search in platform-specific directories (rules, commands, agents)
  const platformConfigs = await buildPlatformSearchConfig(cwd);
  
  for (const config of platformConfigs) {
    // Skip AI directory since it's handled above
    if (config.name === 'ai') {
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
 * Save formula command implementation
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
  const targetVersion = await determineTargetVersion(explicitVersion, versionType, options, formulaInfo.isNewFormula ? undefined : formulaConfig.version, name);

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
  let sourceDir: string;
  if (isExplicitPair && directoryPath) {
    // Pattern 1: Use the explicitly specified directory
    if (directoryPath.startsWith('/')) {
      const absolutePath = directoryPath;
      const relativePath = join(process.cwd(), directoryPath.substring(1));
      // Use the path that exists, prefer absolute
      if (await exists(absolutePath)) {
        sourceDir = absolutePath;
      } else if (await exists(relativePath)) {
        sourceDir = relativePath;
      } else {
        sourceDir = absolutePath; // Default to absolute
      }
    } else {
      sourceDir = join(process.cwd(), directoryPath);
    }
  } else if (isDirectory && directoryPath && !isExplicitPair) {
    // Pattern 2: Legacy directory input - use the directory as source
    if (directoryPath.startsWith('/')) {
      const absolutePath = directoryPath;
      const relativePath = join(process.cwd(), directoryPath.substring(1));
      // Use the path that exists, prefer absolute
      if (await exists(absolutePath)) {
        sourceDir = absolutePath;
      } else if (await exists(relativePath)) {
        sourceDir = relativePath;
      } else {
        sourceDir = absolutePath; // Default to absolute
      }
    } else {
      sourceDir = join(process.cwd(), directoryPath);
    }
  } else {
    // Pattern 3: Legacy formula name input - use formula directory for unified discovery
    sourceDir = formulaDir;
  }

  // Discover and include MD files using appropriate logic
  let discoveredFiles: DiscoveredFile[];
  if (isExplicitPair && directoryPath) {
    // Pattern 1: Explicit name + directory
    const platformInfo = parsePlatformDirectory(directoryPath);
    if (platformInfo) {
      // Directory is a platform-specific directory, search directly in it
      const registryPathPrefix = platformInfo.relativePath ? join(platformInfo.platform, platformInfo.relativePath) : platformInfo.platform;
      discoveredFiles = await discoverMdFilesInDirectory(sourceDir, formulaConfig.name, platformInfo.platformName, registryPathPrefix);
    } else {
      // Directory is a formula root, search for platform subdirectories
      discoveredFiles = await discoverMdFilesUnified(formulaDir, formulaConfig.name, sourceDir, true);
    }
  } else if (isDirectory && directoryPath && !isExplicitPair) {
    // Pattern 2: Legacy directory input
    const platformInfo = parsePlatformDirectory(directoryPath);
    if (platformInfo) {
      // Directory is a platform-specific directory, search directly in it
      const registryPathPrefix = platformInfo.relativePath ? join(platformInfo.platform, platformInfo.relativePath) : platformInfo.platform;
      discoveredFiles = await discoverMdFilesInDirectory(sourceDir, formulaConfig.name, platformInfo.platformName, registryPathPrefix);
    } else {
      // Directory is a formula root, search for platform subdirectories
      discoveredFiles = await discoverMdFilesUnified(formulaDir, formulaConfig.name, sourceDir, true);
    }
  } else {
    // Pattern 3: Legacy formula name input - use unified discovery from formula directory
    discoveredFiles = await discoverMdFilesUnified(formulaDir, formulaConfig.name);
  }
  console.log(`📄 Found ${discoveredFiles.length} markdown files`);
  
  // Resolve file conflicts (keep latest mtime)
  const resolvedFiles = await resolveFileConflicts(discoveredFiles, targetVersion);
  if (resolvedFiles.length !== discoveredFiles.length) {
    console.log(`📄 Resolved conflicts, keeping ${resolvedFiles.length} files`);
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
  
  console.log(`✅ Saved ${formulaConfig.name}@${formulaConfig.version} (${formulaFiles.length} files)`);
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
    path: 'formula.yml',
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
      console.log(`✓ Updated frontmatter in ${mdFile.relativePath}`);
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
 * Determine target version based on input, version type, and options
 */
async function determineTargetVersion(
  explicitVersion?: string,
  versionType?: string,
  options?: SaveOptions,
  currentVersion?: string,
  formulaName?: string
): Promise<string> {
  if (explicitVersion) {
    console.log(`🎯 Using explicit version: ${explicitVersion}`);
    return explicitVersion;
  }
  
  if (!currentVersion) {
    // If no current version, set to 0.1.0 prerelease version
    const prereleaseVersion = generateLocalVersion('0.1.0');
    console.log(`🎯 No version found, setting to prerelease: ${prereleaseVersion}`);
    return prereleaseVersion;
  }
  
  // Handle bump option with or without stable modifier
  if (options?.bump) {
    if (versionType === 'stable') {
      const bumpedVersion = bumpToStable(currentVersion, options.bump);
      console.log(`🎯 Bumping to stable version: ${currentVersion} → ${bumpedVersion}`);
      return bumpedVersion;
    } else {
      const bumpedVersion = bumpToPrerelease(currentVersion, options.bump);
      console.log(`🎯 Bumping to prerelease version: ${currentVersion} → ${bumpedVersion}`);
      return bumpedVersion;
    }
  }
  
  // Handle stable conversion
  if (versionType === 'stable') {
    if (isPrerelease(currentVersion)) {
      const stableVersion = convertPrereleaseToStable(currentVersion);
      console.log(`🎯 Converting to stable version: ${currentVersion} → ${stableVersion}`);
      return stableVersion;
    } else {
      // Already stable - prompt for confirmation
      console.log(`⚠️  Version ${currentVersion} is already stable.`);
      if (!options?.force) {
        const shouldOverwrite = await promptConfirmation(
          `Overwrite existing stable version ${currentVersion}?`,
          false
        );
        if (!shouldOverwrite) {
          throw new Error('Operation cancelled by user');
        }
      }
      console.log(`🎯 Overwriting stable version: ${currentVersion}`);
      return currentVersion;
    }
  }
  
  // Default behavior - smart increment
  if (isPrerelease(currentVersion)) {
    const localVersion = generateLocalVersion(extractBaseVersion(currentVersion));
    console.log(`🎯 Incrementing prerelease version: ${currentVersion} → ${localVersion}`);
    return localVersion;
  } else {
    // For other stable versions, bump patch and then generate prerelease
    const nextPatchVersion = calculateBumpedVersion(currentVersion, 'patch');
    const localVersion = generateLocalVersion(nextPatchVersion);
    console.log(`🎯 Auto-incrementing to patch prerelease: ${currentVersion} → ${localVersion}`);
    return localVersion;
  }
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
  
  switch (bumpType) {
    case 'patch':
      return parts.length >= 3 ? `${parts[0]}.${parts[1]}.${parts[2] + 1}` : baseVersion;
    case 'minor':
      return parts.length >= 2 ? `${parts[0]}.${parts[1] + 1}.0` : baseVersion;
    case 'major':
      return parts.length >= 1 ? `${parts[0] + 1}.0.0` : baseVersion;
    default:
      throw new Error(`Invalid bump type: ${bumpType}`);
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
    .option('-b, --bump <type>', 'bump version (patch|minor|major). Creates prerelease by default, stable when combined with "stable" argument')
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
      if (actualVersionType && actualVersionType !== 'stable') {
        throw new ValidationError(`Invalid version type: ${actualVersionType}. Only 'stable' is supported.`);
      }

      const result = await saveFormulaCommand(formulaName, actualDirectory, actualVersionType, options);
      if (!result.success) {
        throw new Error(result.error || 'Save operation failed');
      }
    }));
}
