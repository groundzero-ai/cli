import { Command } from 'commander';
import { basename, extname, join } from 'path';
import * as yaml from 'js-yaml';
import { safePrompts } from '../utils/prompts.js';
import { CommandResult } from '../types/index.js';
import { updateMarkdownWithFormulaFrontmatter, parseMarkdownFrontmatter, type FormulaMarkerYml } from '../utils/md-frontmatter.js';
import { readTextFile, writeTextFile, exists, isDirectory, listFiles } from '../utils/fs.js';
import { withErrorHandling, ValidationError, UserCancellationError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { FILE_PATTERNS } from '../constants/index.js';
import { isRootFile } from '../core/save/root-files-sync.js';
import { addFormulaToRootFile } from '../utils/root-file-operations.js';
import { generateYamlKeyValue } from '../utils/yaml-frontmatter.js';
import { buildIndexYmlContent } from '../utils/index-yml.js';

/**
 * Options for the tag command
 */
interface TagOptions {
  // No specific options needed for initial implementation
}

/**
 * Result of the tag command operation
 */
interface TagCommandResult extends CommandResult {
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
 * Read and parse index.yml file
 */
async function readIndexYml(filePath: string): Promise<FormulaMarkerYml | null> {
  try {
    const content = await readTextFile(filePath);
    const parsed = yaml.load(content) as any;
    return parsed || null;
  } catch (error) {
    logger.warn(`Failed to parse index.yml at ${filePath}: ${error}`);
    return null;
  }
}

/**
 * Write formula marker to index.yml file
 */
async function writeIndexYml(filePath: string, marker: FormulaMarkerYml): Promise<void> {
  const yamlContent = buildIndexYmlContent(marker);
  await writeTextFile(filePath, yamlContent);
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
      console.log(`✓ Added formula frontmatter to ${basename(filePath)}`);
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
 * Handle adding formula to a directory by operating on index.yml
 */
async function tagFormulaToDirectory(formulaName: string, targetPath: string): Promise<TagCommandResult> {
  const indexPath = join(targetPath, FILE_PATTERNS.INDEX_YML);

  if (await exists(indexPath)) {
    const parsed = await readIndexYml(indexPath);
    const existingName = parsed?.formula?.name;

    if (existingName === formulaName) {
      // Same formula: update without prompt to ensure latest formatting
      await writeIndexYml(indexPath, {
        formula: {
          name: existingName,
          id: parsed?.formula?.id,
          platformSpecific: parsed?.formula?.platformSpecific
        }
      });
      console.log(`✓ Updated index.yml (same formula, refreshed formatting)`);
      return {
        success: true,
        filesProcessed: 1,
        filesSkipped: 0,
        data: {
          formulaName,
          targetPath,
          indexPath
        }
      } as TagCommandResult;
    }

    if (existingName && existingName !== formulaName) {
      // Different formula: prompt for override
      const decision = await promptFormulaOverride(indexPath, existingName, formulaName);

      if (decision === 'skip') {
        console.log(`⊝ Skipped index.yml (keeping existing formula '${existingName}')`);
        return {
          success: true,
          filesProcessed: 0,
          filesSkipped: 1,
          data: {
            formulaName,
            targetPath,
            indexPath
          }
        } as TagCommandResult;
      } else {
        // Overwrite
        await writeIndexYml(indexPath, {
          formula: {
            name: formulaName,
            id: parsed?.formula?.id,
            platformSpecific: parsed?.formula?.platformSpecific
          }
        });
        console.log(`✓ Updated index.yml (overrode '${existingName}' with '${formulaName}')`);
        return {
          success: true,
          filesProcessed: 1,
          filesSkipped: 0,
          data: {
            formulaName,
            targetPath,
            indexPath
          }
        } as TagCommandResult;
      }
    }
  }

  // No existing index.yml: create new one
  await writeIndexYml(indexPath, { formula: { name: formulaName } });
  console.log(`✓ Created index.yml with formula '${formulaName}'`);
  return {
    success: true,
    filesProcessed: 1,
    filesSkipped: 0,
    data: {
      formulaName,
      targetPath,
      indexPath
    }
  } as TagCommandResult;
}

/**
 * Main tag command implementation
 */
async function tagFormulaCommand(
  formulaName: string,
  targetPath: string,
  options: TagOptions = {}
): Promise<TagCommandResult> {
  try {
    logger.info(`Tagging formula '${formulaName}' to: ${targetPath}`);

    // Check if target is a single root file
    const pathExists = await exists(targetPath);
    const isDir = pathExists && await isDirectory(targetPath);

    if (!isDir && isRootFile(targetPath)) {
      // Handle single root file
      const result = await addFormulaToRootFile(targetPath, formulaName);

      return {
        success: true,
        filesProcessed: result.processed ? 1 : 0,
        filesSkipped: result.processed ? 0 : 1,
        data: {
          formulaName,
          targetPath,
          filesProcessed: result.processed ? 1 : 0,
          filesSkipped: result.processed ? 0 : 1,
          isRootFile: true
        }
      } as TagCommandResult;
    }

    if (isDir) {
      // Handle directory: operate on index.yml only
      return await tagFormulaToDirectory(formulaName, targetPath);
    }

    // Handle regular markdown files (existing logic for single files)
    const markdownFiles = await getMarkdownFiles(targetPath);

    // Show what we're about to process
    console.log(`Found ${markdownFiles.length} markdown file(s) in: ${targetPath}`);

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
    } as TagCommandResult;
    
  } catch (error) {
    if (error instanceof UserCancellationError) {
      throw error; // Re-throw to be handled by withErrorHandling
    }
    
    logger.error('Failed to tag formula to files', { error, formulaName, targetPath });
    throw error instanceof Error ? error : new Error(`Tag operation failed: ${error}`);
  }
}

/**
 * Setup the tag command
 */
export function setupTagCommand(program: Command): void {
  program
    .command('tag')
    .argument('<formula-name>', 'formula name to add to markdown files')
    .argument('<path>', 'path to markdown file or directory containing markdown files')
    .description('Add formula frontmatter to markdown files')
    .action(withErrorHandling(async (formulaName: string, path: string, options?: TagOptions) => {
      const result = await tagFormulaCommand(formulaName, path, options);
      if (!result.success) {
        throw new Error(result.error || 'Tag operation failed');
      }
    }));
}
