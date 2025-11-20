import { basename } from 'path';
import { isJunk } from 'junk';
import { Command } from 'commander';
import { CommandResult } from '../types/index.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, PackageNotFoundError } from '../utils/errors.js';
import { describeVersionRange, isExactVersion } from '../utils/version-ranges.js';
import { parsePackageInput } from '../utils/package-name.js';
import { packageManager } from '../core/package.js';

/**
 * Show package details command implementation (supports package@version)
 */
async function showPackageCommand(packageInput: string): Promise<CommandResult> {
  logger.debug(`Showing details for package input: ${packageInput}`);
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  try {
    // Parse input (supports name@version or name@range)
    const { name, version } = parsePackageInput(packageInput);
    
    // Load package (resolves ranges to a specific version)
    const package = await packageManager.loadPackage(name, version);
    const metadata = package.metadata;
    const files = package.files;
    
    // Display package details
    console.log(`✓ Package: ${metadata.name}`);
    
    console.log(`✓ Version: ${metadata.version}`);
    if (metadata.description) {
      console.log(`✓ Description: ${metadata.description}`);
    }
    if (metadata.keywords && metadata.keywords.length > 0) {
      console.log(`✓ Keywords: ${metadata.keywords.join(', ')}`);
    }
    if (metadata.author) {
      console.log(`✓ Author: ${metadata.author}`);
    }
    if (metadata.license) {
      console.log(`✓ License: ${metadata.license}`);
    }
    if (metadata.homepage) {
      console.log(`✓ Homepage: ${metadata.homepage}`);
    }
    if (metadata.repository) {
      const repo = metadata.repository;
      console.log(`✓ Repository: ${repo.type} - ${repo.url}${repo.directory ? ` (directory: ${repo.directory})` : ''}`);
    }
    console.log(`✓ Private: ${metadata.private ? 'Yes' : 'No'}`);

    // Dependencies section
    if (metadata.packages && metadata.packages.length > 0) {
      console.log(`✓ Imported Packages (${metadata.packages.length}):`);
      for (const dep of metadata.packages) {
        const rangeDescription = !isExactVersion(dep.version) 
          ? ` (${describeVersionRange(dep.version)})`
          : '';
        console.log(`  • ${dep.name}@${dep.version}${rangeDescription}`);
      }
    }
    
    if (metadata['dev-packages'] && metadata['dev-packages'].length > 0) {
      console.log(`✓ Imported Dev Packages (${metadata['dev-packages'].length}):`);
      for (const dep of metadata['dev-packages']) {
        const rangeDescription = !isExactVersion(dep.version) 
          ? ` (${describeVersionRange(dep.version)})`
          : '';
        console.log(`  • ${dep.name}@${dep.version}${rangeDescription}`);
      }
    }
    
    // Files section - match install command's file list format
    const filteredFiles = files.filter(f => !isJunk(basename(f.path)));
    const sortedFilePaths = filteredFiles.map(f => f.path).sort((a, b) => a.localeCompare(b));
    console.log(`✓ Files: ${sortedFilePaths.length}`);
    for (const filePath of sortedFilePaths) {
      console.log(`   ├── ${filePath}`);
    }
    console.log('');
    
    return {
      success: true,
      data: metadata
    };
  } catch (error) {
    // Align with other commands' UX for not found
    if (error instanceof PackageNotFoundError) {
      return { success: false, error: `Package '${packageInput}' not found` };
    }
    throw new Error(`Failed to show package: ${error}`);
  }
}


/**
 * Setup the show command
 */
export function setupShowCommand(program: Command): void {
  program
    .command('show')
    .description('Show details of a package. Supports versioning with package@version syntax.')
    .argument('<package-name>', 'name of the package to show. Supports package@version syntax.')
    .action(withErrorHandling(async (packageInput: string) => {
      await showPackageCommand(packageInput);
    }));
}
