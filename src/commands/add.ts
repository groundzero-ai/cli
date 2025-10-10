import { Command } from 'commander';
import { basename, extname } from 'path';
import { safePrompts } from '../utils/prompts.js';
import { CommandResult } from '../types/index.js';
import { updateMarkdownWithFormulaFrontmatter, parseMarkdownFrontmatter } from '../utils/formula-yml.js';
import { readTextFile, writeTextFile, exists, isDirectory, listFiles } from '../utils/fs.js';
import { withErrorHandling, ValidationError, UserCancellationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { FILE_PATTERNS } from '../constants/index.js';

/**
 * Options for the add command
 */
interface AddOptions {
  // No specific options needed for initial implementation
}

/**
 * Result of the add command operation
 */
interface AddCommandResult extends CommandResult {
  filesProcessed?: number;
  filesSkipped?: number;
}


/**
 * Prompt user for formula override decision
 */
async function promptFormulaOverride(
  filePath: string,
  existingFormula: string,
  newFormula: string
): Promise<'skip' | 'overwrite'> {
  const fileName = basename(filePath);
  
  const response = await safePrompts({
    type: 'select',
    name: 'choice',
    message: `File '${fileName}' already has formula '${existingFormula}'. How would you like to proceed?`,
    choices: [
      {
        title: 'Skip - Keep existing formula',
        value: 'skip',
        description: `Keep existing formula '${existingFormula}'`
      },
      {
        title: `Overwrite - Replace with '${newFormula}'`,
        value: 'overwrite',
        description: `Replace with formula '${newFormula}'`
      }
    ],
    hint: 'Use arrow keys to navigate, Enter to select'
  });

  return response.choice;
}

/**
 * Validate that the path is a markdown file
 */
function isMarkdownFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ext === FILE_PATTERNS.MD_FILES || ext === FILE_PATTERNS.MDC_FILES;
}

/**
 * Get all markdown files from the given path
 */
async function getMarkdownFiles(targetPath: string): Promise<string[]> {
  const pathExists = await exists(targetPath);
  if (!pathExists) {
    throw new ValidationError(`Path does not exist: ${targetPath}`);
  }

  const isDir = await isDirectory(targetPath);
  
  if (isDir) {
    // Directory: get all markdown files in immediate children
    const files = await listFiles(targetPath);
    const markdownFiles = files
      .filter(isMarkdownFile)
      .map(file => `${targetPath}/${file}`);
    
    if (markdownFiles.length === 0) {
      throw new ValidationError(`No markdown files found in directory: ${targetPath}`);
    }
    
    return markdownFiles;
  } else {
    // Single file: validate it's a markdown file
    if (!isMarkdownFile(targetPath)) {
      throw new ValidationError(`File is not a markdown file: ${targetPath}`);
    }
    
    return [targetPath];
  }
}

/**
 * Process a single markdown file
 */
async function processMarkdownFile(
  filePath: string,
  formulaName: string
): Promise<{ processed: boolean; reason?: string }> {
  logger.debug(`Processing file: ${filePath}`);
  
  try {
    const content = await readTextFile(filePath);
    const frontmatter = parseMarkdownFrontmatter(content);
    
    const existingFormulaName = frontmatter?.formula?.name;
    
    if (existingFormulaName) {
      if (existingFormulaName === formulaName) {
        // Same formula: update without prompt to ensure latest formatting
        const updatedContent = updateMarkdownWithFormulaFrontmatter(content, { name: formulaName });
        await writeTextFile(filePath, updatedContent);
        console.log(`✓ Updated ${basename(filePath)} (same formula, refreshed formatting)`);
        return { processed: true };
      } else {
        // Different formula: prompt for override
        const decision = await promptFormulaOverride(filePath, existingFormulaName, formulaName);
        
        if (decision === 'skip') {
          console.log(`⊝ Skipped ${basename(filePath)} (keeping existing formula '${existingFormulaName}')`);
          return { processed: false, reason: 'user_skipped' };
        } else {
          // Overwrite
          const updatedContent = updateMarkdownWithFormulaFrontmatter(content, { name: formulaName });
          await writeTextFile(filePath, updatedContent);
          console.log(`✓ Updated ${basename(filePath)} (overrode '${existingFormulaName}' with '${formulaName}')`);
          return { processed: true };
        }
      }
    } else {
      // No existing formula: add new frontmatter
      const updatedContent = updateMarkdownWithFormulaFrontmatter(content, { name: formulaName });
      await writeTextFile(filePath, updatedContent);
      console.log(`✓ Added formula to ${basename(filePath)}`);
      return { processed: true };
    }
  } catch (error) {
    if (error instanceof UserCancellationError) {
      throw error; // Re-throw to be handled by withErrorHandling
    }
    
    logger.error(`Failed to process file: ${filePath}`, { error });
    console.log(`✗ Failed to process ${basename(filePath)}: ${error}`);
    return { processed: false, reason: 'error' };
  }
}

/**
 * Main add command implementation
 */
async function addFormulaCommand(
  formulaName: string,
  targetPath: string,
  options: AddOptions = {}
): Promise<AddCommandResult> {
  try {
    logger.info(`Adding formula '${formulaName}' to: ${targetPath}`);
    
    // Get all markdown files to process
    const markdownFiles = await getMarkdownFiles(targetPath);
    
    // Show what we're about to process
    const isDir = await isDirectory(targetPath);
    if (isDir) {
      console.log(`Found ${markdownFiles.length} markdown file(s) in directory: ${targetPath}`);
    }
    
    let filesProcessed = 0;
    let filesSkipped = 0;
    
    // Process each file
    for (let i = 0; i < markdownFiles.length; i++) {
      const filePath = markdownFiles[i];
      
      if (markdownFiles.length > 1) {
        console.log(`\nProcessing file ${i + 1} of ${markdownFiles.length}: ${basename(filePath)}`);
      }
      
      const result = await processMarkdownFile(filePath, formulaName);
      
      if (result.processed) {
        filesProcessed++;
      } else {
        filesSkipped++;
      }
    }
    
    // Summary
    console.log('\n🎉 Add operation complete!');
    console.log(`   ✓ ${filesProcessed} file(s) updated`);
    if (filesSkipped > 0) {
      console.log(`   ⊝ ${filesSkipped} file(s) skipped`);
    }
    
    return {
      success: true,
      filesProcessed,
      filesSkipped,
      data: {
        formulaName,
        targetPath,
        filesProcessed,
        filesSkipped
      }
    };
    
  } catch (error) {
    if (error instanceof UserCancellationError) {
      throw error; // Re-throw to be handled by withErrorHandling
    }
    
    logger.error('Failed to add formula to markdown files', { error, formulaName, targetPath });
    throw error instanceof Error ? error : new Error(`Add operation failed: ${error}`);
  }
}

/**
 * Setup the add command
 */
export function setupAddCommand(program: Command): void {
  program
    .command('add')
    .argument('<formula-name>', 'formula name to add to markdown files')
    .argument('<path>', 'path to markdown file or directory containing markdown files')
    .description('Add formula frontmatter to markdown files')
    .action(withErrorHandling(async (formulaName: string, path: string, options?: AddOptions) => {
      const result = await addFormulaCommand(formulaName, path, options);
      if (!result.success) {
        throw new Error(result.error || 'Add operation failed');
      }
    }));
}
