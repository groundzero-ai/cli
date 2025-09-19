import { Command } from 'commander';
import { join, dirname, basename } from 'path';
import * as semver from 'semver';
import { SaveOptions, CommandResult, FormulaYml, FormulaFile } from '../types/index.js';
import { parseFormulaYml, writeFormulaYml } from '../utils/formula-yml.js';
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
  
  // Add formula.yml as the first file (will be updated if version changes)
  let formulaYmlContent = await readTextFile(formulaYmlPath);
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
    
    // If it's a markdown file, save it to the ai/ subdirectory
    if (file.path.endsWith('.md')) {
      const aiDir = join(targetPath, 'ai');
      await ensureDir(aiDir);
      filePath = join(aiDir, file.path);
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
