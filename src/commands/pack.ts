import { Command } from 'commander';
import { PackOptions, CommandResult } from '../types/index.js';
import { withErrorHandling } from '../utils/errors.js';
import { runSavePipeline } from '../core/save/save-pipeline.js';

async function packPackageCommand(
  packageName: string,
  options?: PackOptions
): Promise<CommandResult> {
  return runSavePipeline(packageName, {
    mode: 'stable',
    force: options?.force,
    rename: options?.rename
  });
}

export function setupPackCommand(program: Command): void {
  program
    .command('pack')
    .argument('<package-name>', 'package name (no @version syntax)')
    .description('Promote the current workspace package to a stable registry copy.')
    .option('-f, --force', 'overwrite existing stable versions or skip confirmations')
    .option('--rename <newName>', 'Rename package during pack')
    .action(withErrorHandling(async (packageName: string, options?: PackOptions) => {
      const result = await packPackageCommand(packageName, options);
      if (!result.success) {
        throw new Error(result.error || 'Pack operation failed');
      }
    }));
}

