import { Command } from 'commander';

import { withErrorHandling } from '../utils/errors.js';
import { runAddPipeline, type AddPipelineOptions } from '../core/add/add-pipeline.js';

export function setupAddCommand(program: Command): void {
  program
    .command('add')
    .argument('<package-name>', 'package to add workspace files into')
    .argument('<path>', 'file or directory to add (relative to current directory)')
    .description(
      'Copy supported workspace files or directories into a local package directory.\n' +
      'Usage examples:\n' +
      '  opkg add my-package .cursor/rules/example.md\n' +
      '  opkg add my-package ai/helpers/\n'
    )
    .option('--platform-specific', 'Save platform-specific variants for platform subdir inputs')
    .action(
      withErrorHandling(async (packageName: string, inputPath: string, options: AddPipelineOptions) => {
        const result = await runAddPipeline(packageName, inputPath, options);
        if (!result.success) {
          throw new Error(result.error || 'Add operation failed');
        }
      })
    );
}
