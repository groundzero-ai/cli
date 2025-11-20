import { Command } from 'commander';
import { ListOptions, CommandResult } from '../types/index.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { registryManager } from '../core/registry.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling } from '../utils/errors.js';
import { displayPackageTable, PackageTableEntry } from '../utils/formatters.js';
import { arePackageNamesEquivalent } from '../utils/package-name.js';

/**
 * List packages command implementation
 */
async function listPackagesCommand(options: ListOptions): Promise<CommandResult> {
  logger.info('Listing local packages');
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  try {
    // If package name is provided, use exact matching; otherwise use filter
    const filter = options.packageName || options.filter;
    // When package name is specified, show all versions automatically
    const showAllVersions = options.packageName ? true : options.all;
    const entries = await registryManager.listPackages(filter, showAllVersions);
    
    // If a specific package name was provided, filter for exact matches only
    let filteredEntries = entries;
    if (options.packageName) {
      const target =options.packageName;
      filteredEntries = entries.filter(entry => arePackageNamesEquivalent(entry.name, target));
    }
    
    if (filteredEntries.length === 0) {
      if (options.packageName) {
        console.log(`Package not found: ${options.packageName}`);
      } else if (options.filter) {
        console.log(`No packages found matching filter: ${options.filter}`);
      } else {
        console.log('No packages found. Use "opn init" to create your first package.');
      }
      return { success: true, data: [] };
    }
    
    // Display results
    if (options.format === 'json') {
      console.log(JSON.stringify(filteredEntries, null, 2));
    } else {
      // Table format using shared formatter
      const tableEntries: PackageTableEntry[] = filteredEntries.map(entry => ({
        name: entry.name,
        version: entry.version,
        description: entry.description
      }));
      
      let title: string;
      if (options.packageName) {
        title = `Package '${options.packageName}' (all versions):`;
      } else {
        title = options.all ? 'Local packages (all versions):' : 'Local packages (latest versions):';
      }
      
      displayPackageTable(tableEntries, title, showAllVersions);
    }
    
    return {
      success: true,
      data: filteredEntries
    };
  } catch (error) {
    logger.error('Failed to list packages', { error });
    throw new Error(`Failed to list packages: ${error}`);
  }
}


/**
 * Setup the list command
 */
export function setupListCommand(program: Command): void {
  program
    .command('list [package-name]')
    .alias('ls')
    .description('List local packages or show all versions of specific package if name provided')
    .option('--format <format>', 'output format (table|json)', 'table')
    .option('--filter <pattern>', 'filter packages by name pattern')
    .option('--all', 'show all versions (default shows only latest)')
    .action(withErrorHandling(async (packageName: string | undefined, options: ListOptions) => {
      options.packageName = packageName;
      await listPackagesCommand(options);
    }));
}
