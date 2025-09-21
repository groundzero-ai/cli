import { Command } from 'commander';
import { join, dirname, basename } from 'path';
import * as semver from 'semver';
import { SaveOptions, CommandResult, FormulaYml, FormulaFile } from '../types/index.js';
import { parseFormulaYml, writeFormulaYml, parseMarkdownFrontmatter, updateMarkdownWithFormulaFrontmatter } from '../utils/formula-yml.js';
import { promptNewVersion, promptConfirmation, promptVersionConflictResolution, promptOverwriteConfirmation } from '../utils/prompts.js';
import { detectTemplateFile } from '../utils/template.js';
import { ensureRegistryDirectories, getFormulaVersionPath, hasFormulaVersion, getLatestFormulaVersion } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, UserCancellationError, FormulaNotFoundError } from '../utils/errors.js';
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
const COMMAND_DIRECTORIES = [
  { name: CURSOR_COMMANDS_DIR, basePath: CURSOR_COMMANDS_DIR },
  { name: CLAUDE_COMMANDS_DIR, basePath: CLAUDE_COMMANDS_DIR }
] as const;


/**
 * Recursively find files by extension in a directory
 */
async function findFilesByExtension(
  dir: string, 
  extension: string, 
  baseDir: string = dir
): Promise<Array<{ fullPath: string; relativePath: string }>> {
  const files: Array<{ fullPath: string; relativePath: string }> = [];
  
  if (!(await exists(dir)) || !(await isDirectory(dir))) {
    return files;
  }
  
  // Check for files with the specified extension in current directory
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
  for (const subdir of subdirs) {
    const fullPath = join(dir, subdir);
    const subFiles = await findFilesByExtension(fullPath, extension, baseDir);
    files.push(...subFiles);
  }
  
  return files;
}

/**
 * Recursively find all markdown files in a directory
 */
async function findAllMarkdownFiles(dir: string, baseDir: string = dir): Promise<Array<{ fullPath: string; relativePath: string }>> {
  return findFilesByExtension(dir, MARKDOWN_EXTENSION, baseDir);
}

/**
 * Recursively find all formula.yml files in a directory
 */
async function findAllFormulaYmlFiles(dir: string, baseDir: string = dir): Promise<Array<{ fullPath: string; relativePath: string }>> {
  return findFilesByExtension(dir, FORMULA_YML_FILE, baseDir);
}

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
  formulaName?: string,
  options?: SaveOptions
): Promise<CommandResult> {
  const cwd = process.cwd();
  
  if (!formulaName) {
    throw new Error('Formula name is required');
  }
  
  logger.info(`Saving formula with name: ${formulaName}`);
  
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
  
  // Discover and include MD files based on new frontmatter rules
  const discoveredFiles = await discoverMdFiles(formulaDir, formulaConfig.name);
  console.log(`📄 Found ${discoveredFiles.length} markdown files`);
  
  // Create formula files array
  const formulaFiles: FormulaFile[] = [];

  // Add formula.yml as the first file (will be updated if version changes)
  let formulaYmlContent = await readTextFile(formulaYmlPath);
  formulaFiles.push({
    path: 'formula.yml',
    content: formulaYmlContent,
    isTemplate: false,
    encoding: 'utf8'
  });

  // Process discovered MD files in parallel for better performance
  const mdFilePromises = discoveredFiles.map(async (mdFile) => {
    const originalContent = await readTextFile(mdFile.fullPath);
    // Update frontmatter to match current formula
    const updatedContent = updateMarkdownWithFormulaFrontmatter(originalContent, formulaConfig.name);

    // If the content was updated (frontmatter was added or modified), write it back to the source file
    if (updatedContent !== originalContent) {
      await writeTextFile(mdFile.fullPath, updatedContent);
      console.log(`✓ Updated frontmatter in ${mdFile.relativePath}`);
    }

    // Determine the path for registry storage based on source directory
    let registryPath: string;
    if (mdFile.sourceDir === AI_DIR) {
      // Flatten AI files - store only the filename without directory structure
      registryPath = basename(mdFile.relativePath);
    } else if (mdFile.sourceDir === CURSOR_COMMANDS_DIR) {
      registryPath = join('.cursor', 'commands', basename(mdFile.relativePath));
    } else if (mdFile.sourceDir === CLAUDE_COMMANDS_DIR) {
      registryPath = join('.claude', 'commands', basename(mdFile.relativePath));
    } else {
      registryPath = mdFile.relativePath; // Fallback for local files
    }

    return {
      path: registryPath,
      content: updatedContent,
      isTemplate: detectTemplateFile(updatedContent),
      encoding: 'utf8' as const
    };
  });

  const processedMdFiles = await Promise.all(mdFilePromises);
  formulaFiles.push(...processedMdFiles);
  
  // Save formula to local registry with version handling
  const saveResult = await saveFormulaToRegistry(formulaConfig, formulaFiles, formulaYmlPath, options?.force);
  
  // Handle save failure
  if (!saveResult.success) {
    // Check if it's a version error (show simple message)
    if (saveResult.error && saveResult.error.includes('cannot be lower than existing version')) {
      console.error(`❌ ${saveResult.error}`);
      process.exit(1);
    }
    
    return {
      success: false,
      error: saveResult.error || 'Failed to save formula'
    };
  }
  
  // Update formulaConfig if version was changed during save
  if (saveResult.updatedConfig) {
    formulaConfig = saveResult.updatedConfig;
  }
  
  // Success output
  console.log(`✓ Formula '${formulaConfig.name}' saved successfully`);
  console.log(`📦 Version: ${formulaConfig.version}`);
  if (formulaConfig.description) {
    console.log(`📝 Description: ${formulaConfig.description}`);
  }
  console.log(`📁 Files: ${formulaFiles.length} files included`);
  if (formulaConfig.keywords && formulaConfig.keywords.length > 0) {
    console.log(`🏷️  Keywords: ${formulaConfig.keywords.join(', ')}`);
  }
  if (formulaConfig.formulas && formulaConfig.formulas.length > 0) {
    console.log(`📋 Dependencies: ${formulaConfig.formulas.map(f => `${f.name}@${f.version}`).join(', ')}`);
  }
  if (formulaConfig['dev-formulas'] && formulaConfig['dev-formulas'].length > 0) {
    console.log(`🔧 Dev Dependencies: ${formulaConfig['dev-formulas'].map(f => `${f.name}@${f.version}`).join(', ')}`);
  }
  
  return {
    success: true,
    data: formulaConfig
  };
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
  const mdFiles: Array<{ fullPath: string; relativePath: string; sourceDir: string }> = [];

  // Process files in parallel for better performance
  const processPromises = allMdFiles.map(async (mdFile) => {
    try {
      const content = await readTextFile(mdFile.fullPath);
      const frontmatter = parseMarkdownFrontmatter(content);
      const mdFileDir = dirname(mdFile.relativePath);

      // For AI directory: include files adjacent to formula.yml or with matching frontmatter
      if (sourceDir === AI_DIR) {
        if (frontmatter?.formula?.name === formulaName) {
          logger.debug(`Including ${mdFile.relativePath} from ai (matches formula name in frontmatter)`);
          return { fullPath: mdFile.fullPath, relativePath: mdFile.relativePath, sourceDir };
        } else if (mdFileDir === formulaDirRelativeToAi && (!frontmatter || !frontmatter.formula)) {
          logger.debug(`Including ${mdFile.relativePath} from ai (adjacent to formula.yml, no conflicting frontmatter)`);
          return { fullPath: mdFile.fullPath, relativePath: mdFile.relativePath, sourceDir };
        } else if (frontmatter?.formula?.name && frontmatter.formula.name !== formulaName) {
          logger.debug(`Skipping ${mdFile.relativePath} from ai (frontmatter specifies different formula: ${frontmatter.formula.name})`);
        } else {
          logger.debug(`Skipping ${mdFile.relativePath} from ai (not adjacent to formula.yml and no matching frontmatter)`);
        }
      } 
      // For command directories: only include files with matching frontmatter
      else {
        if (frontmatter?.formula?.name === formulaName) {
          logger.debug(`Including ${mdFile.relativePath} from ${sourceDir} (matches formula name in frontmatter)`);
          return { fullPath: mdFile.fullPath, relativePath: mdFile.relativePath, sourceDir };
        } else {
          logger.debug(`Skipping ${mdFile.relativePath} from ${sourceDir} (no matching frontmatter)`);
        }
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
 * Bump patch version (e.g., 1.2.3 → 1.2.4)
 */
function bumpPatchVersion(version: string): string {
  const parts = version.split('.');
  if (parts.length >= 3) {
    const patch = parseInt(parts[2], 10) + 1;
    return `${parts[0]}.${parts[1]}.${patch}`;
  }
  return version;
}

/**
 * Bump minor version (e.g., 1.2.3 → 1.3.0)
 */
function bumpMinorVersion(version: string): string {
  const parts = version.split('.');
  if (parts.length >= 2) {
    const minor = parseInt(parts[1], 10) + 1;
    return `${parts[0]}.${minor}.0`;
  }
  return version;
}

/**
 * Handle version conflicts and updates
 */
async function handleVersionConflict(
  config: FormulaYml,
  formulaYmlPath: string,
  files: FormulaFile[],
  force?: boolean
): Promise<{ success: boolean; error?: string; updatedConfig?: FormulaYml }> {
  const latestVersion = await getLatestFormulaVersion(config.name);
  const versionExists = await hasFormulaVersion(config.name, config.version);
  
  // Case 1: Exact version match exists - prompt for resolution
  if (versionExists) {
    logger.warn(`Formula version '${config.name}@${config.version}' already exists`);
    console.warn(`⚠️  Version '${config.version}' already exists in the local registry.`);
    
    if (force) {
      logger.info('Force flag provided, overwriting existing version');
      return { success: true, updatedConfig: config };
    }
    
    try {
      // Prompt user for resolution
      const resolution = await promptVersionConflictResolution(config.name, config.version);
      
      let updatedConfig: FormulaYml;
      
      switch (resolution) {
        case 'bump-patch': {
          const newVersion = bumpPatchVersion(config.version);
          updatedConfig = { ...config, version: newVersion };
          console.log(`📈 Bumping patch version: ${config.version} → ${newVersion}`);
          break;
        }
        case 'bump-minor': {
          const newVersion = bumpMinorVersion(config.version);
          updatedConfig = { ...config, version: newVersion };
          console.log(`📈 Bumping minor version: ${config.version} → ${newVersion}`);
          break;
        }
        case 'overwrite': {
          // Double confirmation for overwrite
          const confirmed = await promptOverwriteConfirmation(config.name, config.version);
          if (!confirmed) {
            throw new UserCancellationError('Overwrite cancelled by user');
          }
          console.log(`⚠️  Overwriting existing version: ${config.version}`);
          updatedConfig = config;
          break;
        }
        default:
          throw new Error(`Unknown resolution: ${resolution}`);
      }
      
      // Update formula.yml file with new version (if changed)
      if (updatedConfig.version !== config.version) {
        await writeFormulaYml(formulaYmlPath, updatedConfig);
        logger.info(`Updated formula.yml with new version: ${updatedConfig.version}`);
        
        // Update the formula.yml content in the files array to match the new version
        const updatedFormulaYmlContent = await readTextFile(formulaYmlPath);
        const formulaYmlFile = files.find(f => f.path === FORMULA_YML_FILE);
        if (formulaYmlFile) {
          formulaYmlFile.content = updatedFormulaYmlContent;
        }
        
        // Recursively check the new version
        return handleVersionConflict(updatedConfig, formulaYmlPath, files, force);
      }
      
      return { success: true, updatedConfig };
    } catch (error) {
      if (error instanceof UserCancellationError) {
        throw error;
      }
      return {
        success: false,
        error: `Failed to resolve version conflict: ${error}`
      };
    }
  }
  
  // Case 2: No exact match exists - check version relationship with latest
  if (latestVersion) {
    if (semver.gt(config.version, latestVersion)) {
      // Later version - proceed without warning
      logger.info(`Creating new formula version '${config.name}@${config.version}' (later than latest ${latestVersion})`);
    } else if (semver.lt(config.version, latestVersion)) {
      // Lower version - issue warning and ask for confirmation
      logger.warn(`Saving lower-than-latest version for '${config.name}': ${config.version} < ${latestVersion}`);
      console.warn(`⚠️  Version ${config.version} is lower than the latest ${latestVersion}. Saving older versions may have unintended side effects (e.g., tools or workflows expecting newer versions).`);
      
      if (!force) {
        const shouldProceed = await promptConfirmation(
          `Proceed with saving lower version '${config.version}' (latest is ${latestVersion})?`,
          false
        );
        
        if (!shouldProceed) {
          throw new UserCancellationError('Save cancelled by user');
        }
      } else {
        logger.info('Force flag provided, proceeding with lower version');
      }
    } else {
      // Equal version - this shouldn't happen due to exact match check above, but handle it
      logger.info(`Creating new formula version '${config.name}@${config.version}'`);
    }
  } else {
    // No existing versions - proceed without any checks
    logger.info(`Creating first version of formula '${config.name}@${config.version}'`);
  }
  
  return { success: true, updatedConfig: config };
}

/**
 * Save formula to local registry with comprehensive version handling
 */
async function saveFormulaToRegistry(
  config: FormulaYml, 
  files: FormulaFile[], 
  formulaYmlPath: string,
  force?: boolean
): Promise<{ success: boolean; error?: string; updatedConfig?: FormulaYml }> {
  // Handle version conflicts and updates
  const versionResult = await handleVersionConflict(config, formulaYmlPath, files, force);
  if (!versionResult.success) {
    return versionResult;
  }
  
  const finalConfig = versionResult.updatedConfig || config;
  
  // Save files to versioned directory
  const targetPath = getFormulaVersionPath(finalConfig.name, finalConfig.version);
  await ensureDir(targetPath);
  
  // Group files by directory to minimize ensureDir calls
  const directoryGroups = new Map<string, FormulaFile[]>();
  
  for (const file of files) {
    let targetDir: string;
    
    if (file.path.endsWith(MARKDOWN_EXTENSION)) {
      if (file.path.startsWith(CURSOR_COMMANDS_DIR)) {
        targetDir = join(targetPath, '.cursor', 'commands');
      } else if (file.path.startsWith(CLAUDE_COMMANDS_DIR)) {
        targetDir = join(targetPath, '.claude', 'commands');
      } else {
        targetDir = join(targetPath, AI_DIR);
      }
    } else {
      targetDir = targetPath;
    }
    
    if (!directoryGroups.has(targetDir)) {
      directoryGroups.set(targetDir, []);
    }
    directoryGroups.get(targetDir)!.push(file);
  }
  
  // Ensure all directories exist and save files in parallel
  const savePromises = Array.from(directoryGroups.entries()).map(async ([dir, dirFiles]) => {
    await ensureDir(dir);
    
    const filePromises = dirFiles.map(async (file) => {
      let filePath: string;
      
      if (file.path.endsWith(MARKDOWN_EXTENSION)) {
        if (file.path.startsWith(CURSOR_COMMANDS_DIR) || file.path.startsWith(CLAUDE_COMMANDS_DIR)) {
          filePath = join(dir, basename(file.path));
        } else {
          // For AI files, the path is already flattened (just the filename), so use it directly
          filePath = join(dir, file.path);
        }
      } else {
        filePath = join(dir, file.path);
      }
      
      await writeTextFile(filePath, file.content, (file.encoding as BufferEncoding) || 'utf8');
    });
    
    await Promise.all(filePromises);
  });
  
  await Promise.all(savePromises);
  
  logger.info(`Formula '${finalConfig.name}@${finalConfig.version}' saved to local registry`);
  return { 
    success: true, 
    updatedConfig: finalConfig !== config ? finalConfig : undefined 
  };
}

/**
 * Setup the save command
 */
export function setupSaveCommand(program: Command): void {
  program
    .command('save')
    .argument('<formula-name>', 'name of the formula to save')
    .description('Save a formula to local registry by searching for formula.yml files with the specified name')
    .option('-f, --force', 'force save even if formula already exists')
    .action(withErrorHandling(async (formulaName: string, options?: SaveOptions) => {
      const result = await saveFormulaCommand(formulaName, options);
      if (!result.success) {
        throw new Error(result.error || 'Save operation failed');
      }
    }));
}
