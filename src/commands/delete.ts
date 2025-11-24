import { Command } from 'commander';
import { DeleteOptions, CommandResult } from '../types/index.js';
import { ensureRegistryDirectories, listPackageVersions, hasPackageVersion } from '../core/directory.js';
import { packageManager } from '../core/package.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, UserCancellationError, PackageNotFoundError } from '../utils/errors.js';
import { promptVersionSelection, promptVersionDelete, promptAllVersionsDelete, promptPrereleaseVersionsDelete } from '../utils/prompts.js';
import { isPrereleaseVersion } from '../utils/version-ranges.js';
import { extractBaseVersion } from '../utils/version-generator.js';
import { parsePackageInput } from '../utils/package-name.js';

/**
 * Get prerelease versions for a specific base version
 */
function getPrereleaseVersionsForBase(versions: string[], baseVersion: string): string[] {
  return versions.filter(version =>
    isPrereleaseVersion(version) && extractBaseVersion(version) === baseVersion
  );
}

/**
 * Determine what should be deleted based on options and input
 */
async function determineDeletionScope(
  packageName: string,
  version: string | undefined,
  options: DeleteOptions
): Promise<{ type: 'all' | 'specific' | 'prerelease'; version?: string; baseVersion?: string; versions?: string[] }> {
  // Get versions once and reuse
  const versions = await listPackageVersions(packageName);
  if (versions.length === 0) {
    throw new PackageNotFoundError(packageName);
  }
  
  // If version is specified in input
  if (version) {
    // Check if it's a specific prerelease version
    if (isPrereleaseVersion(version)) {
      if (!versions.includes(version)) {
        throw new PackageNotFoundError(`${packageName}@${version}`);
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
      throw new PackageNotFoundError(`${packageName}@${version}`);
    }
    return { type: 'specific', version, versions };
  }
  
  // If interactive mode, let user select
  if (options.interactive) {
    if (versions.length === 1) {
      return { type: 'specific', version: versions[0], versions };
    }
    
    const selectedVersion = await promptVersionSelection(packageName, versions, 'to delete');
    return { type: 'specific', version: selectedVersion, versions };
  }
  
  // Default: delete all versions (backward compatibility)
  return { type: 'all', versions };
}

/**
 * Validate that the deletion target exists
 */
async function validateDeletionTarget(
  packageName: string,
  deletionScope: { type: 'all' | 'specific' | 'prerelease'; version?: string; baseVersion?: string; versions?: string[] }
): Promise<void> {
  if (deletionScope.type === 'specific') {
    // Check if specific version exists
    if (!(await hasPackageVersion(packageName, deletionScope.version!))) {
      throw new PackageNotFoundError(`${packageName}@${deletionScope.version}`);
    }
  } else if (deletionScope.type === 'prerelease') {
    // Check if any prerelease versions exist for the base version
    const prereleaseVersions = getPrereleaseVersionsForBase(deletionScope.versions!, deletionScope.baseVersion!);
    if (prereleaseVersions.length === 0) {
      throw new PackageNotFoundError(`${packageName}@${deletionScope.baseVersion} (no prerelease versions found)`);
    }
  } else {
    // Check if package exists (any version)
    if (!(await packageManager.packageExists(packageName))) {
      throw new PackageNotFoundError(packageName);
    }
  }
}

/**
 * Delete package command implementation
 */
async function deletePackageCommand(
  packageInput: string, 
  options: DeleteOptions
): Promise<CommandResult> {
  logger.info(`Deleting package: ${packageInput}`);
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  // Parse package input
  const { name: packageName, version: inputVersion } = parsePackageInput(packageInput);
  
  // Determine what to delete
  const deletionScope = await determineDeletionScope(packageName, inputVersion, options);
  
  // Validate deletion target exists
  await validateDeletionTarget(packageName, deletionScope);
  
  // Confirmation prompt (if not forced)
  if (!options.force) {
    let shouldDelete: boolean;
    
    if (deletionScope.type === 'specific') {
      shouldDelete = await promptVersionDelete(packageName, deletionScope.version!);
    } else if (deletionScope.type === 'prerelease') {
      const prereleaseVersions = getPrereleaseVersionsForBase(deletionScope.versions!, deletionScope.baseVersion!);
      shouldDelete = await promptPrereleaseVersionsDelete(packageName, deletionScope.baseVersion!, prereleaseVersions);
    } else {
      shouldDelete = await promptAllVersionsDelete(packageName, deletionScope.versions!.length);
    }
    
    // Handle user cancellation (Ctrl+C or 'n')
    if (!shouldDelete) {
      throw new UserCancellationError();
    }
  }
  
  // Execute deletion
  try {
    if (deletionScope.type === 'specific') {
      await packageManager.deletePackageVersion(packageName, deletionScope.version!);
      console.log(`✓ Version '${deletionScope.version}' of package '${packageName}' deleted successfully`);
    } else if (deletionScope.type === 'prerelease') {
      const prereleaseVersions = getPrereleaseVersionsForBase(deletionScope.versions!, deletionScope.baseVersion!);
      
      // Delete all prerelease versions
      for (const version of prereleaseVersions) {
        await packageManager.deletePackageVersion(packageName, version);
      }
      
      const versionText = prereleaseVersions.length === 1 ? 'version' : 'versions';
      console.log(`✓ ${prereleaseVersions.length} prerelease ${versionText} of '${packageName}@${deletionScope.baseVersion}' deleted successfully`);
    } else {
      await packageManager.deletePackage(packageName);
      console.log(`✓ All versions of package '${packageName}' deleted successfully`);
    }
    
    return {
      success: true,
      data: { 
        packageName, 
        version: deletionScope.version,
        baseVersion: deletionScope.baseVersion,
        type: deletionScope.type 
      }
    };
  } catch (error) {
    if (error instanceof UserCancellationError) {
      throw error; // Re-throw to be handled by withErrorHandling
    }
    logger.error(`Failed to delete package: ${packageName}`, { error, deletionScope });
    throw error instanceof Error ? error : new Error(`Failed to delete package: ${error}`);
  }
}

/**
 * Setup the delete command
 */
export function setupDeleteCommand(program: Command): void {
  program
    .command('delete')
    .alias('del')
    .description('Delete a package from local registry. Supports versioning with package@version syntax and prerelease version deletion.')
    .argument('<package>', 'package name or package@version to delete. Use package@baseVersion to delete all prerelease versions of that base version.')
    .option('-f, --force', 'skip confirmation prompt')
    .option('-i, --interactive', 'interactively select version to delete')
    .action(withErrorHandling(async (pkg: string, options: DeleteOptions) => {
      const result = await deletePackageCommand(pkg, options);
      if (!result.success) {
        throw new Error(result.error || 'Delete operation failed');
      }
    }));
}
