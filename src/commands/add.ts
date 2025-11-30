import { Command } from 'commander';

import { withErrorHandling } from '../utils/errors.js';
import { runAddPipeline, type AddPipelineOptions } from '../core/add/add-pipeline.js';

export function setupAddCommand(program: Command): void {
  program
    .command('add')
    .argument('[package-or-path]', 'package name, or path when omitting package name')
    .argument('[path]', 'file or directory to add (when first arg is a package name)')
    .description(
      'Copy supported workspace files or directories into a local package directory.\n' +
      'Usage examples:\n' +
      '  opkg add my-package .cursor/rules/example.md\n' +
      '  opkg add my-package ai/helpers/\n' +
      '  opkg add ai/helpers/\n'
    )
    .option('--platform-specific', 'Save platform-specific variants for platform subdir inputs')
    .action(
      withErrorHandling(async (packageOrPath: string | undefined, pathArg: string | undefined, options: AddPipelineOptions) => {
        const result = await runAddPipeline(packageOrPath, pathArg, options);
        if (!result.success) {
          throw new Error(result.error || 'Add operation failed');
        }
      })
    );
}
