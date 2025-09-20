import { Command } from 'commander';
import { join, dirname, basename } from 'path';
import * as semver from 'semver';
import { SaveOptions, CommandResult, FormulaYml, FormulaFile } from '../types/index.js';
import { parseFormulaYml, writeFormulaYml, parseMarkdownFrontmatter, updateMarkdownWithFormulaFrontmatter } from '../utils/formula-yml.js';
import { promptCreateFormula, promptFormulaDetails, promptNewVersion, promptConfirmation } from '../utils/prompts.js';
import { detectTemplateFile } from '../utils/template.js';
import { ensureRegistryDirectories, getFormulaVersionPath, hasFormulaVersion, getLatestFormulaVersion } from '../core/directory.js';
import { registryManager } from '../core/registry.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, UserCancellationError, FormulaNotFoundError } from '../utils/errors.js';
import { 
  exists, 
  readTextFile, 
  writeTextFile, 
  writeJsonFile, 
  listFiles, 
  listDirectories,
  isDirectory,
  ensureDir
} from '../utils/fs.js';


/**
 * Recursively find all markdown files in a directory
 */
async function findAllMarkdownFiles(dir: string, baseDir: string = dir): Promise<Array<{ fullPath: string; relativePath: string }>> {
  const mdFiles: Array<{ fullPath: string; relativePath: string }> = [];
  
  if (!(await exists(dir)) || !(await isDirectory(dir))) {
    return mdFiles;
  }
  
  // Check for markdown files in current directory
  const files = await listFiles(dir);
  for (const file of files) {
    if (file.endsWith('.md')) {
      const fullPath = join(dir, file);
      const relativePath = fullPath.substring(baseDir.length + 1);
      mdFiles.push({
        fullPath,
        relativePath
      });
    }
  }
  
  // Recursively search subdirectories
  const subdirs = await listDirectories(dir);
  for (const subdir of subdirs) {
    const fullPath = join(dir, subdir);
    const subFiles = await findAllMarkdownFiles(fullPath, baseDir);
    mdFiles.push(...subFiles);
  }
  
  return mdFiles;
}

/**
 * Recursively find all formula.yml files in a directory
 */
async function findAllFormulaYmlFiles(dir: string, baseDir: string = dir): Promise<Array<{ fullPath: string; relativePath: string }>> {
  const formulaFiles: Array<{ fullPath: string; relativePath: string }> = [];
  
  if (!(await exists(dir)) || !(await isDirectory(dir))) {
    return formulaFiles;
  }
  
  // Check for formula.yml file in current directory
  const formulaYmlPath = join(dir, 'formula.yml');
  if (await exists(formulaYmlPath)) {
    const relativePath = formulaYmlPath.substring(baseDir.length + 1);
    formulaFiles.push({
      fullPath: formulaYmlPath,
      relativePath
    });
  }
  
  // Get all subdirectories and recurse
  const subdirs = await listDirectories(dir);
  
  for (const subdir of subdirs) {
    const fullPath = join(dir, subdir);
    const subFiles = await findAllFormulaYmlFiles(fullPath, baseDir);
    formulaFiles.push(...subFiles);
  }
  
  return formulaFiles;
}

/**
 * Find formula.yml files with the specified formula name
 */
async function findFormulaYmlByName(formulaName: string): Promise<Array<{ fullPath: string; relativePath: string; config: FormulaYml }>> {
  const cwd = process.cwd();
  const aiDir = join(cwd, 'ai');
  
  if (!(await exists(aiDir)) || !(await isDirectory(aiDir))) {
    return [];
  }
  
  const allFormulaFiles = await findAllFormulaYmlFiles(aiDir);
  const matchingFormulas: Array<{ fullPath: string; relativePath: string; config: FormulaYml }> = [];
  
  for (const formulaFile of allFormulaFiles) {
    try {
      const config = await parseFormulaYml(formulaFile.fullPath);
      if (config.name === formulaName) {
        matchingFormulas.push({
          fullPath: formulaFile.fullPath,
          relativePath: formulaFile.relativePath,
          config
        });
      }
    } catch (error) {
      logger.warn(`Failed to parse formula.yml at ${formulaFile.fullPath}: ${error}`);
    }
  }
  
  return matchingFormulas;
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

  // Add discovered MD files with updated frontmatter
  for (const mdFile of discoveredFiles) {
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
    if (mdFile.sourceDir === 'ai') {
      // Flatten AI files - store only the filename without directory structure
      registryPath = basename(mdFile.relativePath);
    } else if (mdFile.sourceDir === '.cursor/commands') {
      registryPath = join('.cursor', 'commands', basename(mdFile.relativePath));
    } else if (mdFile.sourceDir === '.claude/commands') {
      registryPath = join('.claude', 'commands', basename(mdFile.relativePath));
    } else {
      registryPath = mdFile.relativePath; // Fallback for local files
    }

    formulaFiles.push({
      path: registryPath,
      content: updatedContent,
      isTemplate: detectTemplateFile(updatedContent),
      encoding: 'utf8'
    });
  }
  
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
 * Discover MD files based on new frontmatter rules from multiple directories
 */
async function discoverMdFiles(formulaDir: string, formulaName: string): Promise<Array<{ fullPath: string; relativePath: string; sourceDir: string }>> {
  const mdFiles: Array<{ fullPath: string; relativePath: string; sourceDir: string }> = [];
  const cwd = process.cwd();
  const aiDir = join(cwd, 'ai');

  // Calculate the relative path of the formula directory from the ai directory
  const formulaDirRelativeToAi = formulaDir.substring(aiDir.length + 1);

  // 1. Process AI directory - include files adjacent to formula.yml and files with matching frontmatter
  if (await exists(aiDir) && await isDirectory(aiDir)) {
    const allAiMdFiles = await findAllMarkdownFiles(aiDir, aiDir);
    
    for (const mdFile of allAiMdFiles) {
      try {
        const content = await readTextFile(mdFile.fullPath);
        const frontmatter = parseMarkdownFrontmatter(content);
        const mdFileDir = dirname(mdFile.relativePath);

        // Check if file has frontmatter specifying this formula name
        if (frontmatter && frontmatter.formula && frontmatter.formula.name === formulaName) {
          logger.debug(`Including ${mdFile.relativePath} from ai (matches formula name in frontmatter)`);
          mdFiles.push({
            fullPath: mdFile.fullPath,
            relativePath: mdFile.relativePath,
            sourceDir: 'ai'
          });
        }
        // Check if file is adjacent to the formula.yml (same directory) and has no conflicting frontmatter
        else if (mdFileDir === formulaDirRelativeToAi && (!frontmatter || !frontmatter.formula)) {
          logger.debug(`Including ${mdFile.relativePath} from ai (adjacent to formula.yml, no conflicting frontmatter)`);
          mdFiles.push({
            fullPath: mdFile.fullPath,
            relativePath: mdFile.relativePath,
            sourceDir: 'ai'
          });
        }
        // Skip files with conflicting frontmatter or files not adjacent to formula.yml
        else if (frontmatter && frontmatter.formula && frontmatter.formula.name !== formulaName) {
          logger.debug(`Skipping ${mdFile.relativePath} from ai (frontmatter specifies different formula: ${frontmatter.formula.name})`);
        } else {
          logger.debug(`Skipping ${mdFile.relativePath} from ai (not adjacent to formula.yml and no matching frontmatter)`);
        }
      } catch (error) {
        logger.warn(`Failed to read or parse ${mdFile.relativePath} from ai: ${error}`);
      }
    }
  }

  // 2. Process command directories - only include files with matching frontmatter
  const commandDirectories = [
    { name: '.cursor/commands', basePath: '.cursor/commands' },
    { name: '.claude/commands', basePath: '.claude/commands' }
  ];

  for (const cmdDir of commandDirectories) {
    const cmdDirPath = join(cwd, cmdDir.basePath);
    
    if (await exists(cmdDirPath) && await isDirectory(cmdDirPath)) {
      const allCmdMdFiles = await findAllMarkdownFiles(cmdDirPath, cmdDirPath);
      
      for (const mdFile of allCmdMdFiles) {
        try {
          const content = await readTextFile(mdFile.fullPath);
          const frontmatter = parseMarkdownFrontmatter(content);

          // Only include files with frontmatter specifying this formula name
          if (frontmatter && frontmatter.formula && frontmatter.formula.name === formulaName) {
            logger.debug(`Including ${mdFile.relativePath} from ${cmdDir.name} (matches formula name in frontmatter)`);
            mdFiles.push({
              fullPath: mdFile.fullPath,
              relativePath: mdFile.relativePath,
              sourceDir: cmdDir.name
            });
          } else {
            logger.debug(`Skipping ${mdFile.relativePath} from ${cmdDir.name} (no matching frontmatter)`);
          }
        } catch (error) {
          logger.warn(`Failed to read or parse ${mdFile.relativePath} from ${cmdDir.name}: ${error}`);
        }
      }
    }
  }

  return mdFiles;
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
  let finalConfig = { ...config };
  
  // Loop to handle version updates until we have a valid version
  while (true) {
    const latestVersion = await getLatestFormulaVersion(finalConfig.name);
    const versionExists = await hasFormulaVersion(finalConfig.name, finalConfig.version);
    
    // Case 1: Exact version match exists - prompt to set new version
    if (versionExists) {
      logger.warn(`Formula version '${finalConfig.name}@${finalConfig.version}' already exists`);
      console.warn(`⚠️  Version '${finalConfig.version}' already exists in the local registry.`);
      
      if (force) {
        logger.info('Force flag provided, overwriting existing version');
        break; // Exit loop and proceed with overwrite
      }
      
      // Show latest version and prompt for new version
      try {
        const versionContext = latestVersion 
          ? `latest: ${latestVersion}, current: ${finalConfig.version}`
          : finalConfig.version;
        const updatedVersion = await promptNewVersion(finalConfig.name, versionContext);
        finalConfig.version = updatedVersion;
        
        // Update formula.yml file with new version
        await writeFormulaYml(formulaYmlPath, finalConfig);
        logger.info(`Updated formula.yml with new version: ${updatedVersion}`);
        
        // Update the formula.yml content in the files array to match the new version
        const updatedFormulaYmlContent = await readTextFile(formulaYmlPath);
        const formulaYmlFile = files.find(f => f.path === 'formula.yml');
        if (formulaYmlFile) {
          formulaYmlFile.content = updatedFormulaYmlContent;
        }
        
        // Continue loop to check the new version
        continue;
      } catch (error) {
        if (error instanceof UserCancellationError) {
          throw error;
        }
        return {
          success: false,
          error: `Failed to update version: ${error}`
        };
      }
    }
    
    // Case 2: No exact match exists - check version relationship with latest
    if (latestVersion) {
      if (semver.gt(finalConfig.version, latestVersion)) {
        // Later version - proceed without warning
        logger.info(`Creating new formula version '${finalConfig.name}@${finalConfig.version}' (later than latest ${latestVersion})`);
        break;
      } else if (semver.lt(finalConfig.version, latestVersion)) {
        // Lower version - issue warning and ask for confirmation
        logger.warn(`Saving lower-than-latest version for '${finalConfig.name}': ${finalConfig.version} < ${latestVersion}`);
        console.warn(`⚠️  Version ${finalConfig.version} is lower than the latest ${latestVersion}. Saving older versions may have unintended side effects (e.g., tools or workflows expecting newer versions).`);
        
        if (!force) {
          const shouldProceed = await promptConfirmation(
            `Proceed with saving lower version '${finalConfig.version}' (latest is ${latestVersion})?`,
            false
          );
          
          if (!shouldProceed) {
            throw new UserCancellationError('Save cancelled by user');
          }
        } else {
          logger.info('Force flag provided, proceeding with lower version');
        }
        break;
      } else {
        // Equal version - this shouldn't happen due to exact match check above, but handle it
        logger.info(`Creating new formula version '${finalConfig.name}@${finalConfig.version}'`);
        break;
      }
    } else {
      // No existing versions - proceed without any checks
      logger.info(`Creating first version of formula '${finalConfig.name}@${finalConfig.version}'`);
      break;
    }
  }
  
  // Save files to versioned directory
  const targetPath = getFormulaVersionPath(finalConfig.name, finalConfig.version);
  await ensureDir(targetPath);
  
  for (const file of files) {
    let filePath: string;

    // If it's a markdown file, determine the appropriate subdirectory
    if (file.path.endsWith('.md')) {
      if (file.path.startsWith('.cursor/commands/')) {
        // File from .cursor/commands directory
        const cursorDir = join(targetPath, '.cursor', 'commands');
        await ensureDir(cursorDir);
        filePath = join(cursorDir, basename(file.path));
      } else if (file.path.startsWith('.claude/commands/')) {
        // File from .claude/commands directory
        const claudeDir = join(targetPath, '.claude', 'commands');
        await ensureDir(claudeDir);
        filePath = join(claudeDir, basename(file.path));
      } else {
        // File from ai directory or local - save to ai/ subdirectory
        const aiDir = join(targetPath, 'ai');
        await ensureDir(aiDir);
        // For AI files, the path is already flattened (just the filename), so use it directly
        filePath = join(aiDir, file.path);
      }
    } else {
      // Save non-MD files (like formula.yml) directly to the version directory
      filePath = join(targetPath, file.path);
    }

    await writeTextFile(filePath, file.content, (file.encoding as BufferEncoding) || 'utf8');
  }
  
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
