#!/usr/bin/env node

import { Command } from 'commander';
import { logger } from './utils/logger.js';
import { ensureOpenPackageDirectories } from './core/directory.js';
import { getVersion } from './utils/package.js';

// Import command setup functions
import { setupInitCommand } from './commands/init.js';
import { setupAddCommand } from './commands/add.js';
import { setupSaveCommand } from './commands/save.js';
import { setupListCommand } from './commands/list.js';
import { setupDeleteCommand } from './commands/delete.js';
import { setupPruneCommand } from './commands/prune.js';
import { setupShowCommand } from './commands/show.js';
import { setupInstallCommand } from './commands/install.js';
import { setupUninstallCommand } from './commands/uninstall.js';
import { setupStatusCommand } from './commands/status.js';
import { setupPushCommand } from './commands/push.js';
import { setupPullCommand } from './commands/pull.js';
import { setupConfigureCommand } from './commands/configure.js';
import { setupDuplicateCommand } from './commands/duplicate.js';

/**
 * OpenPackage CLI - Main entry point
 * 
 * A scalable command-line tool for packaging AI coding files.
 */

// Create the main program
const program = new Command();

// Configure the main program
program
  .name('openpackage')
  .alias('opn')
  .description('OpenPackage - The Package Manager for AI Coding')
  .version(getVersion())
  .configureHelp({
    sortSubcommands: true,
  });

// === FORMULA APPLICATION COMMANDS ===
setupInitCommand(program);
setupAddCommand(program);
setupSaveCommand(program);
setupInstallCommand(program);
setupUninstallCommand(program);
setupStatusCommand(program);

// === LOCAL REGISTRY OPERATIONS ===
setupListCommand(program);
setupShowCommand(program);
setupDuplicateCommand(program);
setupDeleteCommand(program);
setupPruneCommand(program);

// === REMOTE REGISTRY OPERATIONS ===
setupPushCommand(program);
setupPullCommand(program);

// === CONFIGURATION ===
setupConfigureCommand(program);

// === GLOBAL ERROR HANDLING ===

/**
 * Handle uncaught exceptions gracefully
 */
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception occurred', { error: error.message, stack: error.stack });
  console.error('❌ An unexpected error occurred. Please check the logs for details.');
  process.exit(1);
});

/**
 * Handle unhandled promise rejections
 */
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled promise rejection', { reason, promise });
  console.error('❌ An unexpected error occurred. Please check the logs for details.');
  process.exit(1);
});

/**
 * Initialize OpenPackage directories on startup
 */
async function initializeOpenPackage(): Promise<void> {
  try {
    await ensureOpenPackageDirectories();
    logger.debug('OpenPackage directories initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize OpenPackage directories', { error });
    console.error('❌ Failed to initialize OpenPackage directories. Please check permissions.');
    process.exit(1);
  }
}

/**
 * Main execution function
 */
export async function run(): Promise<void> {
  try {
    // Initialize OpenPackage directories
    await initializeOpenPackage();
    
    // Parse command line arguments
    await program.parseAsync();
    
  } catch (error) {
    logger.error('CLI execution failed', { error });
    console.error('❌ Command execution failed. Use --help for usage information.');
    process.exit(1);
  }
}

// Only run main if this file is executed directly
// Check if this module is the main module being executed
// Note: When running via bin/openpackage, the wrapper script calls run() explicitly
if (process.argv[1] && (
    process.argv[1].endsWith('index.js') ||
    process.argv[1].endsWith('index.ts')
  )) {
  run().catch((error) => {
    logger.error('Fatal error in main execution', { error });
    console.error('❌ Fatal error occurred. Exiting.');
    process.exit(1);
  });
}

// Export the program for testing purposes
export { program };