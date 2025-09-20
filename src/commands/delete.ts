import { Command } from 'commander';
import { DeleteOptions, CommandResult } from '../types/index.js';
import { ensureRegistryDirectories, listFormulaVersions, hasFormulaVersion } from '../core/directory.js';
import { formulaManager } from '../core/formula.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, UserCancellationError, FormulaNotFoundError } from '../utils/errors.js';
import { promptFormulaDelete, promptVersionSelection, promptVersionDelete, promptAllVersionsDelete } from '../utils/prompts.js';

/**
 * Parse formula input to extract name and version
 */
function parseFormulaInput(formulaInput: string): { name: string; version?: string } {
  const atIndex = formulaInput.lastIndexOf('@');
  
  if (atIndex === -1) {
    // No version specified
    return { name: formulaInput };
  }
  
  const name = formulaInput.substring(0, atIndex);
  const version = formulaInput.substring(atIndex + 1);
  
  if (!name || !version) {
    throw new Error(`Invalid formula syntax: ${formulaInput}. Use 'formula' or 'formula@version'`);
  }
  
  return { name, version };
}

/**
 * Determine what should be deleted based on options and input
 */
async function determineDeletionScope(
  formulaName: string,
  version: string | undefined,
  options: DeleteOptions
): Promise<{ type: 'all' | 'specific'; version?: string }> {
  // If version is specified in input, delete specific version
  if (version) {
    return { type: 'specific', version };
  }
  
  // If interactive mode, let user select
  if (options.interactive) {
    const versions = await listFormulaVersions(formulaName);
    if (versions.length === 0) {
      throw new FormulaNotFoundError(formulaName);
    }
    
    if (versions.length === 1) {
      // Only one version, ask for confirmation to delete it
      return { type: 'specific', version: versions[0] };
    }
    
    // Multiple versions, let user select
    const selectedVersion = await promptVersionSelection(formulaName, versions);
    return { type: 'specific', version: selectedVersion };
  }
  
  // Default: delete all versions (backward compatibility)
  return { type: 'all' };
}

/**
 * Validate that the deletion target exists
 */
async function validateDeletionTarget(
  formulaName: string,
  deletionScope: { type: 'all' | 'specific'; version?: string }
): Promise<void> {
  if (deletionScope.type === 'specific') {
    // Check if specific version exists
    if (!(await hasFormulaVersion(formulaName, deletionScope.version!))) {
      throw new FormulaNotFoundError(`${formulaName}@${deletionScope.version}`);
    }
  } else {
    // Check if formula exists (any version)
    if (!(await formulaManager.formulaExists(formulaName))) {
      throw new FormulaNotFoundError(formulaName);
    }
  }
}

/**
 * Delete formula command implementation
 */
async function deleteFormulaCommand(
  formulaInput: string, 
  options: DeleteOptions
): Promise<CommandResult> {
  logger.info(`Deleting formula: ${formulaInput}`);
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  // Parse formula input
  const { name: formulaName, version: inputVersion } = parseFormulaInput(formulaInput);
  
  // Determine what to delete
  const deletionScope = await determineDeletionScope(formulaName, inputVersion, options);
  
  // Validate deletion target exists
  await validateDeletionTarget(formulaName, deletionScope);
  
  // Confirmation prompt (if not forced)
  if (!options.force) {
    let shouldDelete: boolean;
    
    if (deletionScope.type === 'specific') {
      shouldDelete = await promptVersionDelete(formulaName, deletionScope.version!);
    } else {
      const versions = await listFormulaVersions(formulaName);
      shouldDelete = await promptAllVersionsDelete(formulaName, versions.length);
    }
    
    // Handle user cancellation (Ctrl+C or 'n')
    if (!shouldDelete) {
      throw new UserCancellationError();
    }
  }
  
  // Execute deletion
  try {
    if (deletionScope.type === 'specific') {
      await formulaManager.deleteFormulaVersion(formulaName, deletionScope.version!);
      console.log(`✓ Version '${deletionScope.version}' of formula '${formulaName}' deleted successfully`);
    } else {
      await formulaManager.deleteFormula(formulaName);
      console.log(`✓ All versions of formula '${formulaName}' deleted successfully`);
    }
    
    return {
      success: true,
      data: { 
        formulaName, 
        version: deletionScope.version,
        type: deletionScope.type 
      }
    };
  } catch (error) {
    logger.error(`Failed to delete formula: ${formulaName}`, { error, deletionScope });
    throw new Error(`Failed to delete formula: ${error}`);
  }
}

/**
 * Setup the delete command
 */
export function setupDeleteCommand(program: Command): void {
  program
    .command('delete')
    .alias('del')
    .description('Delete a formula from local registry. Supports versioning with formula@version syntax.')
    .argument('<formula>', 'formula name or formula@version to delete')
    .option('-f, --force', 'skip confirmation prompt')
    .option('-i, --interactive', 'interactively select version to delete')
    .action(withErrorHandling(async (formula: string, options: DeleteOptions) => {
      const result = await deleteFormulaCommand(formula, options);
      if (!result.success) {
        throw new Error(result.error || 'Delete operation failed');
      }
    }));
}
