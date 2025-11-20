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
 * Show formula details command implementation (supports formula@version)
 */
async function showPackageCommand(formulaInput: string): Promise<CommandResult> {
  logger.debug(`Showing details for formula input: ${formulaInput}`);
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  try {
    // Parse input (supports name@version or name@range)
    const { name, version } = parsePackageInput(formulaInput);
    
    // Load formula (resolves ranges to a specific version)
    const formula = await packageManager.loadPackage(name, version);
    const metadata = formula.metadata;
    const files = formula.files;
    
    // Display formula details
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
    if (metadata.formulas && metadata.formulas.length > 0) {
      console.log(`✓ Imported Packages (${metadata.formulas.length}):`);
      for (const dep of metadata.formulas) {
        const rangeDescription = !isExactVersion(dep.version) 
          ? ` (${describeVersionRange(dep.version)})`
          : '';
        console.log(`  • ${dep.name}@${dep.version}${rangeDescription}`);
      }
    }
    
    if (metadata['dev-formulas'] && metadata['dev-formulas'].length > 0) {
      console.log(`✓ Imported Dev Packages (${metadata['dev-formulas'].length}):`);
      for (const dep of metadata['dev-formulas']) {
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
      return { success: false, error: `Package '${formulaInput}' not found` };
    }
    throw new Error(`Failed to show formula: ${error}`);
  }
}


/**
 * Setup the show command
 */
export function setupShowCommand(program: Command): void {
  program
    .command('show')
    .description('Show details of a formula. Supports versioning with formula@version syntax.')
    .argument('<package-name>', 'name of the formula to show. Supports formula@version syntax.')
    .action(withErrorHandling(async (formulaInput: string) => {
      await showPackageCommand(formulaInput);
    }));
}
