import { Command } from 'commander';
import { join, dirname, basename } from 'path';
import * as yaml from 'js-yaml';
import prompts from 'prompts';
import { CreateOptions, CommandResult, FormulaYml, FormulaFile } from '../types/index.js';
import { ensureRegistryDirectories, getFormulaPath, getFormulaMetadataPath } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling } from '../utils/errors.js';
import { 
  exists, 
  readTextFile, 
  writeTextFile, 
  writeJsonFile, 
  listFiles, 
  isDirectory 
} from '../utils/fs.js';

/**
 * Create formula command implementation
 */
async function createFormulaCommand(
  options: CreateOptions
): Promise<CommandResult> {
  const cwd = process.cwd();
  const formulaYmlPath = join(cwd, 'formula.yml');
  
  logger.info(`Creating formula from current directory: ${cwd}`);
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  let formulaConfig: FormulaYml;
  
  // Check if formula.yml exists
  if (await exists(formulaYmlPath)) {
    logger.info('Found existing formula.yml, parsing...');
    formulaConfig = await parseFormulaYml(formulaYmlPath);
  } else {
    logger.info('No formula.yml found, creating new formula...');
    
    // Confirm with user if they want to create a new formula
    const { shouldCreate } = await prompts({
      type: 'confirm',
      name: 'shouldCreate',
      message: 'No formula.yml found. Would you like to create a new formula?',
      initial: true
    });
    
    if (!shouldCreate) {
      return {
        success: false,
        error: 'Formula creation cancelled by user'
      };
    }
    
    // Prompt for formula details (npm init style)
    formulaConfig = await promptFormulaDetails();
    
    // Create the formula.yml file
    await writeFormulaYml(formulaYmlPath, formulaConfig);
    console.log(`✓ Created formula.yml`);
  }
  
  // Discover and include MD files based on groundzero directory rules
  const mdFiles = await discoverMdFiles(cwd);
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
  
  // Save formula to local registry
  await saveFormulaToRegistry(formulaConfig, formulaFiles);
  
  // Success output
  console.log(`✓ Formula '${formulaConfig.name}' created successfully`);
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
 * Parse formula.yml file
 */
async function parseFormulaYml(formulaYmlPath: string): Promise<FormulaYml> {
  try {
    const content = await readTextFile(formulaYmlPath);
    const parsed = yaml.load(content) as FormulaYml;
    
    // Validate required fields
    if (!parsed.name || !parsed.version) {
      throw new Error('formula.yml must contain name and version fields');
    }
    
    return parsed;
  } catch (error) {
    throw new Error(`Failed to parse formula.yml: ${error}`);
  }
}

/**
 * Write formula.yml file
 */
async function writeFormulaYml(formulaYmlPath: string, config: FormulaYml): Promise<void> {
  const content = yaml.dump(config, {
    indent: 2,
    noArrayIndent: true,
    sortKeys: false
  });
  
  await writeTextFile(formulaYmlPath, content);
}

/**
 * Prompt user for formula details (npm init style)
 */
async function promptFormulaDetails(): Promise<FormulaYml> {
  const cwd = process.cwd();
  const defaultName = basename(cwd);
  
  const response = await prompts([
    {
      type: 'text',
      name: 'name',
      message: 'Formula name:',
      initial: defaultName,
      validate: (value: string) => {
        if (!value) return 'Name is required';
        if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
          return 'Name can only contain letters, numbers, hyphens, and underscores';
        }
        return true;
      }
    },
    {
      type: 'text',
      name: 'version',
      message: 'Version:',
      initial: '0.1.0',
      validate: (value: string) => {
        if (!value) return 'Version is required';
        if (!/^\d+\.\d+\.\d+/.test(value)) {
          return 'Version should follow semantic versioning (e.g., 1.0.0)';
        }
        return true;
      }
    },
    {
      type: 'text',
      name: 'description',
      message: 'Description:'
    },
    {
      type: 'list',
      name: 'keywords',
      message: 'Keywords (comma-separated):',
      separator: ','
    },
    {
      type: 'confirm',
      name: 'private',
      message: 'Private formula?',
      initial: false
    }
  ]);
  
  // Handle user cancellation
  if (!response.name) {
    throw new Error('Formula creation cancelled');
  }
  
  const config: FormulaYml = {
    name: response.name,
    version: response.version,
    ...(response.description && { description: response.description }),
    ...(response.keywords && response.keywords.length > 0 && { keywords: response.keywords }),
    ...(response.private && { private: response.private })
  };
  
  return config;
}

/**
 * Discover MD files based on groundzero directory rules
 */
async function discoverMdFiles(cwd: string): Promise<Array<{ fullPath: string; relativePath: string }>> {
  const mdFiles: Array<{ fullPath: string; relativePath: string }> = [];
  const parentDir = dirname(cwd);
  const groundzeroPath = join(parentDir, 'groundzero');
  
  // Check if adjacent groundzero directory exists
  if (await exists(groundzeroPath) && await isDirectory(groundzeroPath)) {
    logger.debug('Found adjacent groundzero directory, including its immediate MD files (flattened)');
    
    // Include all immediate MD files from groundzero directory (not recursive)
    // Store them flattened without the groundzero/ prefix
    const files = await listFiles(groundzeroPath);
    for (const file of files) {
      if (file.endsWith('.md')) {
        const fullPath = join(groundzeroPath, file);
        mdFiles.push({
          fullPath,
          relativePath: file // Store directly without 'groundzero/' prefix
        });
      }
    }
  } else {
    logger.debug('No groundzero directory found, including adjacent MD files');
    
    // Include all MD files adjacent (siblings) to formula.yml
    const files = await listFiles(cwd);
    for (const file of files) {
      if (file.endsWith('.md')) {
        const fullPath = join(cwd, file);
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
 * Save formula to local registry
 */
async function saveFormulaToRegistry(config: FormulaYml, files: FormulaFile[]): Promise<void> {
  const formulaPath = getFormulaPath(config.name);
  const metadataPath = getFormulaMetadataPath(config.name);
  
  // Check if formula already exists
  if (await exists(metadataPath)) {
    const { overwrite } = await prompts({
      type: 'confirm',
      name: 'overwrite',
      message: `Formula '${config.name}' already exists. Overwrite?`,
      initial: false
    });
    
    if (!overwrite) {
      throw new Error('Formula creation cancelled - formula already exists');
    }
  }
  
  // Create metadata from formula config
  const metadata = {
    name: config.name,
    version: config.version,
    description: config.description,
    keywords: config.keywords || [],
    private: config.private || false,
    dependencies: config.formulas || [],
    devDependencies: config['dev-formulas'] || [],
    created: new Date().toISOString(),
    updated: new Date().toISOString(),
    files: files.map(f => f.path)
  };
  
  // Save metadata
  await writeJsonFile(metadataPath, metadata);
  
  // Save files to formula directory
  for (const file of files) {
    const filePath = join(formulaPath, file.path);
    await writeTextFile(filePath, file.content, (file.encoding as BufferEncoding) || 'utf8');
  }
  
  logger.info(`Formula '${config.name}' saved to local registry`);
}

/**
 * Detect if a file contains template variables
 */
function detectTemplateFile(content: string): boolean {
  return /\{\{\s*\w+\s*\}\}/.test(content);
}

/**
 * Setup the create command
 */
export function setupCreateCommand(program: Command): void {
  program
    .command('create')
    .description('Create a new formula from the current directory and its formula.yml')
    .option('-f, --force', 'force creation even if formula already exists')
    .action(withErrorHandling(async (options: CreateOptions) => {
      await createFormulaCommand(options);
    }));
}