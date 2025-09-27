import { Command } from 'commander';
import { join, dirname, basename } from 'path';
import { SaveOptions, CommandResult, FormulaYml, FormulaFile } from '../types/index.js';
import { parseFormulaYml, writeFormulaYml, parseMarkdownFrontmatter, updateMarkdownWithFormulaFrontmatter } from '../utils/formula-yml.js';
import { detectTemplateFile } from '../utils/template.js';
import { ensureRegistryDirectories, getFormulaVersionPath, hasFormulaVersion } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, FormulaNotFoundError, ValidationError } from '../utils/errors.js';
import { getLocalGroundZeroDir, getLocalFormulaYmlPath } from '../utils/paths.js';
import { FILE_PATTERNS, PLATFORMS, PLATFORM_DIRS, PLATFORM_SUBDIRS, type Platform } from '../constants/index.js';

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
    registryPath: PLATFORM_DIRS.AI
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
 * Parse formula input to extract name and version/range, or detect directory input
 * Supports both formula names (formula@version) and directory paths (/path/to/dir)
 */
function parseFormulaInput(formulaInput: string): { 
  name: string; 
  version?: string; 
  isDirectory: boolean;
  directoryPath?: string;
} {
  // Check if input is a directory path (starts with /)
  if (formulaInput.startsWith('/')) {
    const directoryPath = formulaInput;
    const name = basename(directoryPath);
    
    if (!name) {
      throw new ValidationError(`Invalid directory path: ${formulaInput}`);
    }
    
    return { 
      name, 
      isDirectory: true, 
      directoryPath 
    };
  }
  
  // Original formula name parsing logic
  const atIndex = formulaInput.lastIndexOf('@');
  
  if (atIndex === -1) {
    return { name: formulaInput, isDirectory: false };
  }
  
  const name = formulaInput.substring(0, atIndex);
  const version = formulaInput.substring(atIndex + 1);
  
  if (!name || !version) {
    throw new ValidationError(`Invalid formula syntax: ${formulaInput}. Use format: formula@version`);
  }
  
  return { name, version, isDirectory: false };
}

/**
 * Create formula.yml automatically in a directory without user prompts
 * Reuses init command logic but makes it non-interactive
 */
async function createFormulaYmlInDirectory(formulaDir: string, formulaName: string): Promise<{ fullPath: string; config: FormulaYml }> {
  const groundzeroDir = getLocalGroundZeroDir(formulaDir);
  const formulaYmlPath = getLocalFormulaYmlPath(formulaDir);
  
  // Ensure the target directory exists
  await ensureDir(groundzeroDir);
  await ensureDir(formulaDir);
  
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
    config: formulaConfig
  };
}

/**
 * Handle directory-based formula input
 * Reuses init command logic for checking existing formula.yml and creating new ones
 */
async function handleDirectoryInput(directoryPath: string, formulaName: string): Promise<{ fullPath: string; config: FormulaYml }> {
  const cwd = process.cwd();
  const formulaDir = join(cwd, directoryPath.substring(1)); // Remove leading '/'
  const formulaYmlPath = getLocalFormulaYmlPath(formulaDir);
  
  logger.debug(`Handling directory input: ${formulaDir}`);
  
  // Check if formula.yml already exists (reusing init command logic)
  if (await exists(formulaYmlPath)) {
    logger.debug('Found existing formula.yml, parsing...');
    try {
      const formulaConfig = await parseFormulaYml(formulaYmlPath);
      console.log(`✓ Found existing formula.yml`);
      console.log(`📦 Name: ${formulaConfig.name}`);
      console.log(`📦 Version: ${formulaConfig.version}`);
      
      return {
        fullPath: formulaYmlPath,
        config: formulaConfig
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
 * Unified file discovery function that searches platform-specific directories
 */
async function discoverMdFilesUnified(formulaDir: string, formulaName: string): Promise<DiscoveredFile[]> {
  const cwd = process.cwd();
  const platformConfigs = await buildPlatformSearchConfig(cwd);
  const allDiscoveredFiles: DiscoveredFile[] = [];
  
  // Process all platform configurations in parallel
  const processPromises = platformConfigs.map(async (config) => {
    const files = await processPlatformFiles(config, formulaDir, formulaName);
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
  formulaName: string
): Promise<DiscoveredFile[]> {
  const allFiles: DiscoveredFile[] = [];

  // Process rules directory
  if (config.rulesDir) {
    const rulesFiles = await processDirectoryFiles(
      config.rulesDir,
      config.name,
      formulaName,
      config.registryPath,
      formulaDir
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
      formulaDir
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
      formulaDir
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
  formulaDir: string
): Promise<DiscoveredFile[]> {
  if (!(await exists(dirPath)) || !(await isDirectory(dirPath))) {
    return [];
  }

  const allMdFiles = await findAllMarkdownFiles(dirPath, dirPath);
  const discoveredFiles: DiscoveredFile[] = [];

  // Process files in parallel
  const processPromises = allMdFiles.map(async (mdFile) => {
    try {
      const content = await readTextFile(mdFile.fullPath);
      const frontmatter = parseMarkdownFrontmatter(content);
      
      if (shouldIncludeMarkdownFileUnified(mdFile, frontmatter, sourceDirName, formulaName, formulaDir)) {
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
  });
  
  const results = await Promise.all(processPromises);
  return results.filter((result): result is NonNullable<typeof result> => result !== null);
}

/**
 * Process files in a directory using platform-specific logic
 */
async function processDirectoryFiles(
  dirPath: string,
  sourceDirName: string,
  formulaName: string,
  registryPath: string,
  formulaDir: string
): Promise<DiscoveredFile[]> {
  if (!(await exists(dirPath)) || !(await isDirectory(dirPath))) {
    return [];
  }

  const allMdFiles = await findAllMarkdownFiles(dirPath, dirPath);
  const discoveredFiles: DiscoveredFile[] = [];

  // Process files in parallel
  const processPromises = allMdFiles.map(async (mdFile) => {
    try {
      const content = await readTextFile(mdFile.fullPath);
      const frontmatter = parseMarkdownFrontmatter(content);
      
      if (shouldIncludeMarkdownFileUnified(mdFile, frontmatter, sourceDirName, formulaName, formulaDir)) {
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
  });

  const results = await Promise.all(processPromises);
  return results.filter((result): result is NonNullable<typeof result> => result !== null);
}

/**
 * Determine if a markdown file should be included based on unified frontmatter rules
 */
function shouldIncludeMarkdownFileUnified(
  mdFile: { relativePath: string },
  frontmatter: any,
  sourceDirName: string,
  formulaName: string,
  formulaDir: string
): boolean {
  const mdFileDir = dirname(mdFile.relativePath);
  
  // For AI directory: include files adjacent to formula.yml or with matching frontmatter
  if (sourceDirName === 'ai') {
    const cwd = process.cwd();
    const aiDir = join(cwd, 'ai');
    const formulaDirRelativeToAi = formulaDir.substring(aiDir.length + 1);
    
    if (frontmatter?.formula?.name === formulaName) {
      logger.debug(`Including ${mdFile.relativePath} from ai (matches formula name in frontmatter)`);
      return true;
    }
    if (mdFileDir === formulaDirRelativeToAi && (!frontmatter || !frontmatter.formula)) {
      logger.debug(`Including ${mdFile.relativePath} from ai (adjacent to formula.yml, no conflicting frontmatter)`);
      return true;
    }
    if (frontmatter?.formula?.name && frontmatter.formula.name !== formulaName) {
      logger.debug(`Skipping ${mdFile.relativePath} from ai (frontmatter specifies different formula: ${frontmatter.formula.name})`);
    } else {
      logger.debug(`Skipping ${mdFile.relativePath} from ai (not adjacent to formula.yml and no matching frontmatter)`);
    }
    return false;
  }
  
  // For other directories: only include files with matching frontmatter
  if (frontmatter?.formula?.name === formulaName) {
    logger.debug(`Including ${mdFile.relativePath} from ${sourceDirName} (matches formula name in frontmatter)`);
    return true;
  }
  
  logger.debug(`Skipping ${mdFile.relativePath} from ${sourceDirName} (no matching frontmatter)`);
  return false;
}

/**
 * Get registry path for a file based on unified directory structure
 */
function getRegistryPathUnified(registryPath: string, relativePath: string, sourceDirName: string): string {
  if (sourceDirName === 'ai') {
    // Flatten AI files to root of ai directory
    return join(registryPath, basename(relativePath));
  } else {
    // Preserve subdirectory structure for other directories
    return join(registryPath, relativePath);
  }
}


/**
 * Find formula.yml files with the specified formula name
 */
async function findFormulaYmlByName(formulaName: string): Promise<Array<{ fullPath: string; relativePath: string; config: FormulaYml }>> {
  const cwd = process.cwd();
  const aiDir = join(cwd, PLATFORM_DIRS.AI);
  
  if (!(await exists(aiDir)) || !(await isDirectory(aiDir))) {
    return [];
  }
  
  const allFormulaFiles = await findAllFormulaYmlFiles(aiDir);
  const matchingFormulas: Array<{ fullPath: string; relativePath: string; config: FormulaYml }> = [];
  
  // Process files in parallel for better performance
  const parsePromises = allFormulaFiles.map(async (formulaFile) => {
    try {
      const config = await parseFormulaYml(formulaFile.fullPath);
      if (config.name === formulaName) {
        return {
          fullPath: formulaFile.fullPath,
          relativePath: formulaFile.relativePath,
          config
        };
      }
    } catch (error) {
      logger.warn(`Failed to parse formula.yml at ${formulaFile.fullPath}: ${error}`);
    }
    return null;
  });
  
  const results = await Promise.all(parsePromises);
  return results.filter((result): result is NonNullable<typeof result> => result !== null);
}

/**
 * Save formula command implementation
 */
async function saveFormulaCommand(
  formulaInput: string,
  versionType?: string,
  options?: SaveOptions
): Promise<CommandResult> {
  const cwd = process.cwd();
  
  // Parse formula input to detect directory vs formula name input
  const { name: formulaName, version: explicitVersion, isDirectory, directoryPath } = parseFormulaInput(formulaInput);
  
  logger.debug(`Saving formula with name: ${formulaName}`, { explicitVersion, isDirectory, directoryPath, options });
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  let formulaInfo: { fullPath: string; config: FormulaYml };
  
  if (isDirectory && directoryPath) {
    // Handle directory input - find or create formula.yml in specified directory
    formulaInfo = await handleDirectoryInput(directoryPath, formulaName);
  } else {
    // Handle traditional formula name input - search for existing formula.yml files
    const matchingFormulas = await findFormulaYmlByName(formulaName);
    
    if (matchingFormulas.length === 0) {
      throw new FormulaNotFoundError(formulaName);
    }
    
    if (matchingFormulas.length > 1) {
      const locations = matchingFormulas.map(f => f.relativePath).join(', ');
      throw new Error(`Multiple formula.yml files found with name '${formulaName}': ${locations}. Please ensure formula names are unique.`);
    }
    
    formulaInfo = {
      fullPath: matchingFormulas[0].fullPath,
      config: matchingFormulas[0].config
    };
  }
  
  const formulaDir = dirname(formulaInfo.fullPath);
  const formulaYmlPath = formulaInfo.fullPath;
  let formulaConfig = formulaInfo.config;
  
  logger.debug(`Found formula.yml at: ${formulaYmlPath}`);
  
  // Determine target version
  const targetVersion = await determineTargetVersion(explicitVersion, versionType, options, formulaConfig.version, formulaName);
  
  // Check if version already exists (unless force is used)
  if (!options?.force) {
    const versionExists = await hasFormulaVersion(formulaName, targetVersion);
    if (versionExists) {
      throw new Error(`Version ${targetVersion} already exists. Use --force to overwrite.`);
    }
  }
  
  // Update formula config with new version
  formulaConfig = { ...formulaConfig, version: targetVersion };
  
  // Discover and include MD files using unified logic
  const discoveredFiles = await discoverMdFilesUnified(formulaDir, formulaConfig.name);
  console.log(`📄 Found ${discoveredFiles.length} markdown files`);
  
  // Resolve file conflicts (keep latest mtime)
  const resolvedFiles = resolveFileConflicts(discoveredFiles);
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
  
  console.log(`✅ Saved ${formulaConfig.name}@${formulaConfig.version} (${formulaFiles.length} files)`);
  return { success: true, data: formulaConfig };
}

/**
 * Process markdown files from a directory with frontmatter filtering
 */
async function processMarkdownFiles(
  dirPath: string,
  sourceDir: string,
  formulaName: string,
  formulaDirRelativeToAi?: string
): Promise<Array<{ fullPath: string; relativePath: string; sourceDir: string }>> {
  if (!(await exists(dirPath)) || !(await isDirectory(dirPath))) {
    return [];
  }

  const allMdFiles = await findAllMarkdownFiles(dirPath, dirPath);

  // Process files in parallel
  const processPromises = allMdFiles.map(async (mdFile) => {
    try {
      const content = await readTextFile(mdFile.fullPath);
      const frontmatter = parseMarkdownFrontmatter(content);
      
      if (shouldIncludeMarkdownFile(mdFile, frontmatter, sourceDir, formulaName, formulaDirRelativeToAi)) {
        return { fullPath: mdFile.fullPath, relativePath: mdFile.relativePath, sourceDir };
      }
    } catch (error) {
      logger.warn(`Failed to read or parse ${mdFile.relativePath} from ${sourceDir}: ${error}`);
    }
    return null;
  });

  const results = await Promise.all(processPromises);
  return results.filter((result): result is NonNullable<typeof result> => result !== null);
}

/**
 * Determine if a markdown file should be included based on frontmatter rules
 */
function shouldIncludeMarkdownFile(
  mdFile: { relativePath: string },
  frontmatter: any,
  sourceDir: string,
  formulaName: string,
  formulaDirRelativeToAi?: string
): boolean {
  const mdFileDir = dirname(mdFile.relativePath);
  
  // For AI directory: include files adjacent to formula.yml or with matching frontmatter
  if (sourceDir === PLATFORM_DIRS.AI) {
    if (frontmatter?.formula?.name === formulaName) {
      logger.debug(`Including ${mdFile.relativePath} from ai (matches formula name in frontmatter)`);
      return true;
    }
    if (mdFileDir === formulaDirRelativeToAi && (!frontmatter || !frontmatter.formula)) {
      logger.debug(`Including ${mdFile.relativePath} from ai (adjacent to formula.yml, no conflicting frontmatter)`);
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
  
  logger.debug(`Skipping ${mdFile.relativePath} from ${sourceDir} (no matching frontmatter)`);
  return false;
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
    throw new Error('No version information available');
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
    .argument('<formula-input>', 'formula name, formula@version, or directory path (/path/to/dir)')
    .argument('[version-type]', 'version type: stable (optional)')
    .description('Save a formula to local registry. Supports directory paths (e.g., /ai/nestjs) to auto-create or find formula.yml files. Auto-generates local dev versions by default.')
    .option('-f, --force', 'overwrite existing version or skip confirmations')
    .option('-b, --bump <type>', 'bump version (patch|minor|major). Creates prerelease by default, stable when combined with "stable" argument')
    .action(withErrorHandling(async (formulaInput: string, versionType?: string, options?: SaveOptions) => {
      // Validate version type argument
      if (versionType && versionType !== 'stable') {
        throw new ValidationError(`Invalid version type: ${versionType}. Only 'stable' is supported.`);
      }
      
      const result = await saveFormulaCommand(formulaInput, versionType, options);
      if (!result.success) {
        throw new Error(result.error || 'Save operation failed');
      }
    }));
}
