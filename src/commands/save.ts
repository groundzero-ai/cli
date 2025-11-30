import { Command } from 'commander';
import { SaveOptions, CommandResult } from '../types/index.js';
import { withErrorHandling } from '../utils/errors.js';
import { runSavePipeline } from '../core/save/save-pipeline.js';

async function savePackageCommand(
  packageName: string | undefined,
  options: SaveOptions = {}
): Promise<CommandResult> {
  return runSavePipeline(packageName, {
    mode: 'wip',
    force: options.force,
    rename: options.rename
  });
}

export function setupSaveCommand(program: Command): void {
  program
    .command('save')
    .alias('s')
    .argument('[package-name]', 'package name (optional if cwd is a package)')
    .description(
      'Save a package snapshot for this workspace.\n' +
      'Usage:\n' +
      '  opkg save                  # Save cwd package (requires .openpackage/package.yml)\n' +
      '  opkg save <package-name>   # Save specific package by name\n' +
      'Use `opkg pack` to create a stable copy in the registry.'
    )
    .option('-f, --force', 'overwrite existing version or skip confirmations')
    .option('--rename <newName>', 'Rename package during save')
    .action(
      withErrorHandling(async (packageName: string | undefined, options?: SaveOptions) => {
        const result = await savePackageCommand(packageName, options ?? {});
        if (!result.success) throw new Error(result.error || 'Save operation failed');
      })
    );
}
