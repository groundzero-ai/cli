import { Command } from 'commander';
import { join, dirname, basename } from 'path';
import { SaveOptions, CommandResult, FormulaYml, FormulaFile } from '../types/index.js';
import { parseFormulaYml, writeFormulaYml, parseMarkdownFrontmatter, updateMarkdownWithFormulaFrontmatter } from '../utils/formula-yml.js';
import { detectTemplateFile } from '../utils/template.js';
import { ensureRegistryDirectories, getFormulaVersionPath, hasFormulaVersion } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, FormulaNotFoundError, ValidationError } from '../utils/errors.js';
import { generateLocalVersion } from '../utils/version-generator.js';
import { 
  exists, 
  readTextFile, 
  writeTextFile, 
  listFiles, 
  listDirectories,
  isDirectory,
  ensureDir
} from '../utils/fs.js';

// Constants
const AI_DIR = 'ai';
const CURSOR_COMMANDS_DIR = '.cursor/commands';
const CLAUDE_COMMANDS_DIR = '.claude/commands';
const FORMULA_YML_FILE = 'formula.yml';
const MARKDOWN_EXTENSION = '.md';
const UTF8_ENCODING = 'utf8' as const;

// Command directories configuration
const COMMAND_DIRECTORIES = [
  { name: CURSOR_COMMANDS_DIR, basePath: CURSOR_COMMANDS_DIR },
  { name: CLAUDE_COMMANDS_DIR, basePath: CLAUDE_COMMANDS_DIR }
] as const;

/**
 * Parse formula input to extract name and version/range
 * Reused from install command for consistency
 */
function parseFormulaInput(formulaInput: string): { name: string; version?: string } {
  const atIndex = formulaInput.lastIndexOf('@');
  
  if (atIndex === -1) {
    return { name: formulaInput };
  }
  
  const name = formulaInput.substring(0, atIndex);
  const version = formulaInput.substring(atIndex + 1);
  
  if (!name || !version) {
    throw new ValidationError(`Invalid formula syntax: ${formulaInput}. Use format: formula@version`);
  }
  
  return { name, version };
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
  findFilesByExtension(dir, FORMULA_YML_FILE, baseDir);

/**
 * Find formula.yml files with the specified formula name
 */
async function findFormulaYmlByName(formulaName: string): Promise<Array<{ fullPath: string; relativePath: string; config: FormulaYml }>> {
  const cwd = process.cwd();
  const aiDir = join(cwd, AI_DIR);
  
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
  options?: SaveOptions
): Promise<CommandResult> {
  const cwd = process.cwd();
  
  // Parse formula input to extract name and optional version
  const { name: formulaName, version: explicitVersion } = parseFormulaInput(formulaInput);
  
  logger.info(`Saving formula with name: ${formulaName}`, { explicitVersion, options });
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  // Search for formula.yml files with the specified name
  const matchingFormulas = await findFormulaYmlByName(formulaName);
  
  if (matchingFormulas.length === 0) {
    throw new FormulaNotFoundError(formulaName);
  }
  
  if (matchingFormulas.length > 1) {
    const locations = matchingFormulas.map(f => f.relativePath).join(', ');
    throw new Error(`Multiple formula.yml files found with name '${formulaName}': ${locations}. Please ensure formula names are unique.`);
  }
  
  const formulaInfo = matchingFormulas[0];
  const formulaDir = dirname(formulaInfo.fullPath);
  const formulaYmlPath = formulaInfo.fullPath;
  let formulaConfig = formulaInfo.config;
  
  logger.info(`Found formula.yml at: ${formulaYmlPath}`);
  
  // Determine target version
  const targetVersion = determineTargetVersion(explicitVersion, options, formulaConfig.version);
  
  // Check if version already exists (unless force is used)
  if (!options?.force) {
    const versionExists = await hasFormulaVersion(formulaName, targetVersion);
    if (versionExists) {
      throw new Error(`Version ${targetVersion} already exists. Use --force to overwrite.`);
    }
  }
  
  // Update formula config with new version
  formulaConfig = { ...formulaConfig, version: targetVersion };
  
  // Discover and include MD files based on new frontmatter rules
  const discoveredFiles = await discoverMdFiles(formulaDir, formulaConfig.name);
  console.log(`📄 Found ${discoveredFiles.length} markdown files`);
  
  // Create formula files array
  const formulaFiles = await createFormulaFiles(formulaYmlPath, formulaConfig, discoveredFiles);
  
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
  if (sourceDir === AI_DIR) {
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
async function discoverMdFiles(formulaDir: string, formulaName: string): Promise<Array<{ fullPath: string; relativePath: string; sourceDir: string }>> {
  const cwd = process.cwd();
  const aiDir = join(cwd, AI_DIR);
  const formulaDirRelativeToAi = formulaDir.substring(aiDir.length + 1);

  // Process all directories in parallel for better performance
  const [aiFiles, cursorFiles, claudeFiles] = await Promise.all([
    processMarkdownFiles(aiDir, AI_DIR, formulaName, formulaDirRelativeToAi),
    processMarkdownFiles(join(cwd, CURSOR_COMMANDS_DIR), CURSOR_COMMANDS_DIR, formulaName),
    processMarkdownFiles(join(cwd, CLAUDE_COMMANDS_DIR), CLAUDE_COMMANDS_DIR, formulaName)
  ]);

  return [...aiFiles, ...cursorFiles, ...claudeFiles];
}

/**
 * Create formula files array with formula.yml and processed markdown files
 */
async function createFormulaFiles(
  formulaYmlPath: string,
  formulaConfig: FormulaYml,
  discoveredFiles: Array<{ fullPath: string; relativePath: string; sourceDir: string }>
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

    const registryPath = getRegistryPath(mdFile.sourceDir, mdFile.relativePath);

    return {
      path: registryPath,
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
 * Get registry path for a file based on its source directory
 */
function getRegistryPath(sourceDir: string, relativePath: string): string {
  switch (sourceDir) {
    case AI_DIR:
      return basename(relativePath); // Flatten AI files
    case CURSOR_COMMANDS_DIR:
      return join('.cursor', 'commands', basename(relativePath));
    case CLAUDE_COMMANDS_DIR:
      return join('.claude', 'commands', basename(relativePath));
    default:
      return relativePath; // Fallback for local files
  }
}

/**
 * Determine target version based on input and options
 */
function determineTargetVersion(
  explicitVersion?: string, 
  options?: SaveOptions, 
  currentVersion?: string
): string {
  if (explicitVersion) {
    console.log(`🎯 Using explicit version: ${explicitVersion}`);
    return explicitVersion;
  }
  
  if (options?.bump && currentVersion) {
    const bumpedVersion = calculateBumpedVersion(currentVersion, options.bump);
    console.log(`🎯 Bumping version: ${currentVersion} → ${bumpedVersion}`);
    return bumpedVersion;
  }
  
  if (currentVersion) {
    const localVersion = generateLocalVersion(currentVersion);
    logger.debug(`Generated local version: ${localVersion}`);
    return localVersion;
  }
  
  throw new Error('No version information available');
}

/**
 * Calculate bumped version based on type
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
 * Get target directory for a file based on its path
 */
function getTargetDirectory(targetPath: string, filePath: string): string {
  if (filePath.endsWith(MARKDOWN_EXTENSION)) {
    if (filePath.startsWith(CURSOR_COMMANDS_DIR)) {
      return join(targetPath, '.cursor', 'commands');
    } else if (filePath.startsWith(CLAUDE_COMMANDS_DIR)) {
      return join(targetPath, '.claude', 'commands');
    } else {
      return join(targetPath, AI_DIR);
    }
  }
  return targetPath;
}

/**
 * Get target file path for saving
 */
function getTargetFilePath(targetDir: string, filePath: string): string {
  if (filePath.endsWith(MARKDOWN_EXTENSION)) {
    if (filePath.startsWith(CURSOR_COMMANDS_DIR) || filePath.startsWith(CLAUDE_COMMANDS_DIR)) {
      return join(targetDir, basename(filePath));
    } else {
      return join(targetDir, filePath);
    }
  }
  return join(targetDir, filePath);
}

/**
 * Setup the save command
 */
export function setupSaveCommand(program: Command): void {
  program
    .command('save')
    .argument('<formula-input>', 'formula name or formula@version')
    .description('Save a formula to local registry. Auto-generates local dev versions by default.')
    .option('-f, --force', 'overwrite existing version')
    .option('-b, --bump <type>', 'bump version (patch|minor|major)')
    .action(withErrorHandling(async (formulaInput: string, options?: SaveOptions) => {
      const result = await saveFormulaCommand(formulaInput, options);
      if (!result.success) {
        throw new Error(result.error || 'Save operation failed');
      }
    }));
}
