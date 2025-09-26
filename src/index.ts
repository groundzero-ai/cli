#!/usr/bin/env node

import { Command } from 'commander';
import { logger } from './utils/logger.js';
import { ensureG0Directories } from './core/directory.js';
import { getVersion } from './utils/package.js';

// Import command setup functions
import { setupInitCommand } from './commands/init.js';
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
import { setupSearchCommand } from './commands/search.js';
import { setupConfigureCommand } from './commands/configure.js';
import { setupAddCommand } from './commands/add.js';

/**
 * G0 Formula Manager CLI - Main entry point
 * 
 * A scalable command-line tool for managing code templates and formulas.
 * Built with TypeScript, Commander.js, and following CLI best practices.
 */

// Create the main program
const program = new Command();

// Configure the main program
program
  .name('g0')
  .description('G0 Formula Manager - Create, manage, and share code templates')
  .version(getVersion());

// === FORMULA LIFECYCLE COMMANDS ===
setupInitCommand(program);
setupSaveCommand(program);
setupListCommand(program);
setupDeleteCommand(program);
setupPruneCommand(program);
setupShowCommand(program);

// === FORMULA APPLICATION COMMANDS ===
setupInstallCommand(program);
setupUninstallCommand(program);
setupAddCommand(program);
setupStatusCommand(program);

// === REGISTRY OPERATIONS ===
setupPushCommand(program);
setupPullCommand(program);
setupSearchCommand(program);

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
 * Initialize G0 directories on startup
 */
async function initializeG0(): Promise<void> {
  try {
    await ensureG0Directories();
    logger.debug('G0 directories initialized successfully');
  } catch (error) {
    logger.error('Failed to initialize G0 directories', { error });
    console.error('❌ Failed to initialize G0 directories. Please check permissions.');
    process.exit(1);
  }
}

/**
 * Main execution function
 */
async function main(): Promise<void> {
  try {
    // Initialize G0 directories
    await initializeG0();
    
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
if (process.argv[1] && (
    process.argv[1].endsWith('index.js') || 
    process.argv[1].endsWith('index.ts') ||
    process.argv[1].endsWith('/g0') ||
    process.argv[1].endsWith('\\g0')
  )) {
  main().catch((error) => {
    logger.error('Fatal error in main execution', { error });
    console.error('❌ Fatal error occurred. Exiting.');
    process.exit(1);
  });
}

// Export the program for testing purposes
export { program };