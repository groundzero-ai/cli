import { Command } from 'commander';
import { DeleteOptions, CommandResult } from '../types/index.js';
import { ensureRegistryDirectories, listFormulaVersions, hasFormulaVersion } from '../core/directory.js';
import { formulaManager } from '../core/formula.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, UserCancellationError, FormulaNotFoundError } from '../utils/errors.js';
import { promptFormulaDelete, promptVersionSelection, promptVersionDelete, promptAllVersionsDelete, promptPrereleaseVersionsDelete } from '../utils/prompts.js';
import { isLocalVersion, extractBaseVersion } from '../utils/version-generator.js';

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
 * Group versions by base version for prerelease handling
 */
function groupVersionsByBase(versions: string[]): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  
  for (const version of versions) {
    const key = isLocalVersion(version) ? extractBaseVersion(version) : version;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(version);
  }
  
  return groups;
}

/**
 * Get prerelease versions for a specific base version
 */
function getPrereleaseVersionsForBase(versions: string[], baseVersion: string): string[] {
  return versions.filter(version => 
    isLocalVersion(version) && extractBaseVersion(version) === baseVersion
  );
}

/**
 * Determine what should be deleted based on options and input
 */
async function determineDeletionScope(
  formulaName: string,
  version: string | undefined,
  options: DeleteOptions
): Promise<{ type: 'all' | 'specific' | 'prerelease'; version?: string; baseVersion?: string; versions?: string[] }> {
  // Get versions once and reuse
  const versions = await listFormulaVersions(formulaName);
  if (versions.length === 0) {
    throw new FormulaNotFoundError(formulaName);
  }
  
  // If version is specified in input
  if (version) {
    // Check if it's a specific prerelease version
    if (isLocalVersion(version)) {
      if (!versions.includes(version)) {
        throw new FormulaNotFoundError(`${formulaName}@${version}`);
      }
      return { type: 'specific', version, versions };
    }
    
    // Check if it's a base version that has prerelease versions
    const prereleaseVersions = getPrereleaseVersionsForBase(versions, version);
    if (prereleaseVersions.length > 0) {
      return { type: 'prerelease', baseVersion: version, versions };
    }
    
    // Regular version - delete specific version
    if (!versions.includes(version)) {
      throw new FormulaNotFoundError(`${formulaName}@${version}`);
    }
    return { type: 'specific', version, versions };
  }
  
  // If interactive mode, let user select
  if (options.interactive) {
    if (versions.length === 1) {
      return { type: 'specific', version: versions[0], versions };
    }
    
    const selectedVersion = await promptVersionSelection(formulaName, versions, 'to delete');
    return { type: 'specific', version: selectedVersion, versions };
  }
  
  // Default: delete all versions (backward compatibility)
  return { type: 'all', versions };
}

/**
 * Validate that the deletion target exists
 */
async function validateDeletionTarget(
  formulaName: string,
  deletionScope: { type: 'all' | 'specific' | 'prerelease'; version?: string; baseVersion?: string; versions?: string[] }
): Promise<void> {
  if (deletionScope.type === 'specific') {
    // Check if specific version exists
    if (!(await hasFormulaVersion(formulaName, deletionScope.version!))) {
      throw new FormulaNotFoundError(`${formulaName}@${deletionScope.version}`);
    }
  } else if (deletionScope.type === 'prerelease') {
    // Check if any prerelease versions exist for the base version
    const prereleaseVersions = getPrereleaseVersionsForBase(deletionScope.versions!, deletionScope.baseVersion!);
    if (prereleaseVersions.length === 0) {
      throw new FormulaNotFoundError(`${formulaName}@${deletionScope.baseVersion} (no prerelease versions found)`);
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
    } else if (deletionScope.type === 'prerelease') {
      const prereleaseVersions = getPrereleaseVersionsForBase(deletionScope.versions!, deletionScope.baseVersion!);
      shouldDelete = await promptPrereleaseVersionsDelete(formulaName, deletionScope.baseVersion!, prereleaseVersions);
    } else {
      shouldDelete = await promptAllVersionsDelete(formulaName, deletionScope.versions!.length);
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
    } else if (deletionScope.type === 'prerelease') {
      const prereleaseVersions = getPrereleaseVersionsForBase(deletionScope.versions!, deletionScope.baseVersion!);
      
      // Delete all prerelease versions
      for (const version of prereleaseVersions) {
        await formulaManager.deleteFormulaVersion(formulaName, version);
      }
      
      const versionText = prereleaseVersions.length === 1 ? 'version' : 'versions';
      console.log(`✓ ${prereleaseVersions.length} prerelease ${versionText} of '${formulaName}@${deletionScope.baseVersion}' deleted successfully`);
    } else {
      await formulaManager.deleteFormula(formulaName);
      console.log(`✓ All versions of formula '${formulaName}' deleted successfully`);
    }
    
    return {
      success: true,
      data: { 
        formulaName, 
        version: deletionScope.version,
        baseVersion: deletionScope.baseVersion,
        type: deletionScope.type 
      }
    };
  } catch (error) {
    if (error instanceof UserCancellationError) {
      throw error; // Re-throw to be handled by withErrorHandling
    }
    logger.error(`Failed to delete formula: ${formulaName}`, { error, deletionScope });
    throw error instanceof Error ? error : new Error(`Failed to delete formula: ${error}`);
  }
}

/**
 * Setup the delete command
 */
export function setupDeleteCommand(program: Command): void {
  program
    .command('delete')
    .alias('del')
    .description('Delete a formula from local registry. Supports versioning with formula@version syntax and prerelease version deletion.')
    .argument('<formula>', 'formula name or formula@version to delete. Use formula@baseVersion to delete all prerelease versions of that base version.')
    .option('-f, --force', 'skip confirmation prompt')
    .option('-i, --interactive', 'interactively select version to delete')
    .action(withErrorHandling(async (formula: string, options: DeleteOptions) => {
      const result = await deleteFormulaCommand(formula, options);
      if (!result.success) {
        throw new Error(result.error || 'Delete operation failed');
      }
    }));
}
