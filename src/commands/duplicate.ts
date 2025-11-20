import { Command } from 'commander';
import * as semver from 'semver';
import { packageManager } from '../core/package.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, PackageNotFoundError } from '../utils/errors.js';
import { Package, CommandResult } from '../types/index.js';
import { parsePackageInput } from '../utils/package-name.js';
import { transformPackageFilesMetadata } from '../utils/package-versioning.js';

async function duplicatePackageCommand(
  sourceInput: string,
  newInput: string
): Promise<CommandResult> {
  logger.info(`Duplicating package: ${sourceInput} -> ${newInput}`);

  // Ensure registry directories
  await ensureRegistryDirectories();

  // Parse inputs
  const { name: sourceName, version: sourceVersionInput } = parsePackageInput(sourceInput);
  const { name: newName, version: newVersionInput } = parsePackageInput(newInput);

  // Validate new version if provided
  if (newVersionInput && !semver.valid(newVersionInput)) {
    throw new Error(`Invalid version: ${newVersionInput}. Must be a valid semver version.`);
  }

  // Load source package (handles ranges; defaults to latest)
  let sourcePackage: Package;
  try {
    sourcePackage = await packageManager.loadPackage(sourceName, sourceVersionInput);
  } catch (error) {
    if (error instanceof PackageNotFoundError) {
      return { success: false, error: `Target package ${sourceName} not found.` };
    }
    throw error instanceof Error ? error : new Error(String(error));
  }

  // Check if any version already exists for the new name
  if (await packageManager.packageExists(newName)) {
    return { success: false, error: `Package ${newName} already exists` };
  }

  // Determine new version
  const newVersion = newVersionInput || sourcePackage.metadata.version;

  // Transform files: update package.yml
  const transformedFiles = transformPackageFilesMetadata(
    sourcePackage.files,
    sourceName,
    newName,
    newVersion
  );

  const newPackage: Package = {
    metadata: {
      ...sourcePackage.metadata,
      name: newName,
      version: newVersion
    },
    files: transformedFiles
  };

  // Save duplicated package
  await packageManager.savePackage(newPackage);

  console.log(`✓ Duplicated '${sourceName}@${sourcePackage.metadata.version}' -> '${newName}@${newVersion}'`);

  return { success: true, data: { from: `${sourceName}@${sourcePackage.metadata.version}`, to: `${newName}@${newVersion}` } };
}

export function setupDuplicateCommand(program: Command): void {
  program
    .command('duplicate')
    .description('Duplicate a package in the local registry to a new name and optional version')
    .argument('<package>', 'source package name or package@version')
    .argument('<newName>', 'new package name or newName@version')
    .action(withErrorHandling(async (pkg: string, newName: string) => {
      const result = await duplicatePackageCommand(pkg, newName);
      if (!result.success) {
        // If we already printed a user-friendly message, just exit with error
        if (result.error) throw new Error(result.error);
      }
    }));
}


