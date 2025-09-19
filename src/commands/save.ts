import { Command } from 'commander';
import { join, dirname, basename } from 'path';
import * as semver from 'semver';
import { SaveOptions, CommandResult, FormulaYml, FormulaFile } from '../types/index.js';
import { parseFormulaYml, writeFormulaYml } from '../utils/formula-yml.js';
import { promptCreateFormula, promptFormulaDetails, promptNewVersion, promptVersionOverwrite } from '../utils/prompts.js';
import { detectTemplateFile } from '../utils/template.js';
import { ensureRegistryDirectories, getFormulaPath } from '../core/directory.js';
import { registryManager } from '../core/registry.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, UserCancellationError, FormulaNotFoundError } from '../utils/errors.js';
import { 
  exists, 
  readTextFile, 
  writeTextFile, 
  writeJsonFile, 
  listFiles, 
  isDirectory,
  ensureDir
} from '../utils/fs.js';

/**
 * Save formula command implementation
 */
async function saveFormulaCommand(
  targetDir?: string,
  options?: SaveOptions
): Promise<CommandResult> {
  const cwd = process.cwd();
  const formulaDir = targetDir ? join(cwd, targetDir) : cwd;
  const formulaYmlPath = join(formulaDir, 'formula.yml');
  
  logger.info(`Saving formula from directory: ${formulaDir}`);
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  let formulaConfig: FormulaYml;
  
  // Check if formula.yml exists
  if (await exists(formulaYmlPath)) {
    logger.info('Found existing formula.yml, parsing...');
    formulaConfig = await parseFormulaYml(formulaYmlPath);
  } else {
    logger.info('No formula.yml found, prompting to create...');
    
    // Confirm with user if they want to create a new formula
    const shouldCreate = await promptCreateFormula();
    
    if (!shouldCreate) {
      throw new UserCancellationError('Formula creation cancelled by user');
    }
    
    // Prompt for formula details (npm init style)
    const defaultName = basename(formulaDir);
    formulaConfig = await promptFormulaDetails(defaultName);
    
    // Create the formula.yml file
    await writeFormulaYml(formulaYmlPath, formulaConfig);
    console.log(`✓ Created formula.yml`);
  }
  
  // Discover and include MD files based on ai directory rules
  const mdFiles = await discoverMdFiles(formulaDir);
  console.log(`📄 Found ${mdFiles.length} markdown files`);
  
  // Create formula files array
  const formulaFiles: FormulaFile[] = [];
  
  // Add formula.yml as the first file
  const formulaYmlContent = await readTextFile(formulaYmlPath);
  formulaFiles.push({
    path: 'formula.yml',
    content: formulaYmlContent,
    isTemplate: false,
    encoding: 'utf8'
  });
  
  // Add discovered MD files
  for (const mdFile of mdFiles) {
    const content = await readTextFile(mdFile.fullPath);
    formulaFiles.push({
      path: mdFile.relativePath,
      content,
      isTemplate: detectTemplateFile(content),
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
 * Discover MD files based on ai directory rules
 */
async function discoverMdFiles(formulaDir: string): Promise<Array<{ fullPath: string; relativePath: string }>> {
  const mdFiles: Array<{ fullPath: string; relativePath: string }> = [];
  const parentDir = dirname(formulaDir);
  const groundzeroPath = join(parentDir, 'ai');
  
  // Check if adjacent ai directory exists
  if (await exists(groundzeroPath) && await isDirectory(groundzeroPath)) {
    logger.debug('Found adjacent ai directory, including its immediate MD files (flattened)');
    
    // Include all immediate MD files from ai directory (not recursive)
    // Store them flattened without the ai/ prefix
    const files = await listFiles(groundzeroPath);
    for (const file of files) {
      if (file.endsWith('.md')) {
        const fullPath = join(groundzeroPath, file);
        mdFiles.push({
          fullPath,
          relativePath: file // Store directly without 'ai/' prefix
        });
      }
    }
  } else {
    logger.debug('No ai directory found, including adjacent MD files');
    
    // Include all MD files adjacent (siblings) to formula.yml
    const files = await listFiles(formulaDir);
    for (const file of files) {
      if (file.endsWith('.md')) {
        const fullPath = join(formulaDir, file);
        mdFiles.push({
          fullPath,
          relativePath: file
        });
      }
    }
  }
  
  return mdFiles;
}

/**
 * Save formula to local registry with version handling
 */
async function saveFormulaToRegistry(
  config: FormulaYml, 
  files: FormulaFile[], 
  formulaYmlPath: string,
  force?: boolean
): Promise<{ success: boolean; error?: string; updatedConfig?: FormulaYml }> {
  const formulaPath = getFormulaPath(config.name);
  
  let finalConfig = { ...config };
  
  // Check if formula already exists and handle version logic
  try {
    const existingMetadata = await registryManager.getFormulaMetadata(config.name);
    const existingVersion = existingMetadata.version;
    const newVersion = config.version;
    
    logger.debug(`Existing formula found`, { existingVersion, newVersion });
    
    // Compare versions
    const versionComparison = semver.compare(newVersion, existingVersion);
    
    if (versionComparison === 0) {
      // Same version - prompt for new version
      logger.info(`Formula '${config.name}' already exists with same version ${existingVersion}`);
      
      if (force) {
        logger.info('Force flag provided, overwriting same version');
      } else {
        try {
          const updatedVersion = await promptNewVersion(config.name, existingVersion);
          finalConfig.version = updatedVersion;
          
          // Update formula.yml file with new version
          await writeFormulaYml(formulaYmlPath, finalConfig);
          logger.info(`Updated formula.yml with new version: ${updatedVersion}`);
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
    } else if (versionComparison > 0) {
      // New version is higher - prompt for confirmation
      logger.info(`Upgrading formula '${config.name}' from ${existingVersion} to ${newVersion}`);
      
      if (!force) {
        const confirmed = await promptVersionOverwrite(config.name, existingVersion, newVersion);
        if (!confirmed) {
          throw new UserCancellationError();
        }
      }
    } else {
      // New version is lower - show error
      return {
        success: false,
        error: `Version ${newVersion} cannot be lower than existing version ${existingVersion}`
      };
    }
    
  } catch (error) {
    if (error instanceof FormulaNotFoundError) {
      // Formula doesn't exist - proceed with creation
      logger.info(`Creating new formula '${config.name}' version ${config.version}`);
    } else {
      // Re-throw other errors (like UserCancellationError)
      throw error;
    }
  }
  
  // Save files to formula directory
  for (const file of files) {
    let filePath: string;
    
    // If it's a markdown file, save it to the ai/ subdirectory
    if (file.path.endsWith('.md')) {
      const aiDir = join(formulaPath, 'ai');
      await ensureDir(aiDir);
      filePath = join(aiDir, file.path);
    } else {
      // Save non-MD files (like formula.yml) directly to the formula directory
      filePath = join(formulaPath, file.path);
    }
    
    await writeTextFile(filePath, file.content, (file.encoding as BufferEncoding) || 'utf8');
  }
  
  logger.info(`Formula '${finalConfig.name}' saved to local registry`);
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
    .argument('[directory]', 'target directory to save formula from (relative to current directory)')
    .description('Save the current formula to local registry (creates formula.yml if needed)')
    .option('-f, --force', 'force save even if formula already exists')
    .action(withErrorHandling(async (directory?: string, options?: SaveOptions) => {
      const result = await saveFormulaCommand(directory, options);
      if (!result.success) {
        throw new Error(result.error || 'Save operation failed');
      }
    }));
}
