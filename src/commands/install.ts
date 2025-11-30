import { Command } from 'commander';

import type { CommandResult, InstallOptions } from '../types/index.js';
import { runBulkInstallPipeline } from '../core/install/bulk-install-pipeline.js';
import { runInstallPipeline, determineResolutionMode } from '../core/install/install-pipeline.js';
import { withErrorHandling } from '../utils/errors.js';
import { normalizePlatforms } from '../utils/platform-mapper.js';
import { parsePackageInput } from '../utils/package-name.js';
import { logger } from '../utils/logger.js';

export function validateResolutionFlags(options: InstallOptions & { local?: boolean; remote?: boolean }): void {
  if (options.remote && options.local) {
    throw new Error('--remote and --local cannot be used together. Choose one resolution mode.');
  }
}

async function installCommand(
  packageName: string | undefined,
  targetDir: string,
  options: InstallOptions
): Promise<CommandResult> {
  options.resolutionMode = determineResolutionMode(options);
  logger.debug('Install resolution mode selected', { mode: options.resolutionMode });

  if (!packageName) {
    return await runBulkInstallPipeline(targetDir, options);
  }

  const { name, version } = parsePackageInput(packageName);
  return await runInstallPipeline({
    ...options,
    packageName: name,
    version,
    targetDir
  });
}

export function setupInstallCommand(program: Command): void {
  program
    .command('install')
    .alias('i')
    .description(
      'Install packages from the local (and optional remote) registry into this workspace. Works with WIP copies from `opkg save` and stable releases from `opkg pack`.'
    )
    .argument('[package-name]', 'name of the package to install (optional - installs all from package.yml if not specified). Supports package@version syntax.')
    .argument('[target-dir]', 'target directory relative to the workspace install root (defaults to ./ai)', '.')
    .option('--dry-run', 'preview changes without applying them')
    .option('--force', 'overwrite existing files')
    .option('--conflicts <strategy>', 'conflict handling strategy: keep-both, overwrite, skip, or ask')
    .option('--dev', 'add package to dev-packages instead of packages')
    .option('--platforms <platforms...>', 'prepare specific platforms (e.g., cursor claudecode opencode)')
    .option('--remote', 'pull and install from remote registry, ignoring local versions')
    .option('--local', 'resolve and install using only local registry versions, skipping remote metadata and pulls')
    .option('--stable', 'prefer the latest stable version when resolving; ignore newer prerelease/WIP versions if a satisfying stable exists')
    .option('--profile <profile>', 'profile to use for authentication')
    .option('--api-key <key>', 'API key for authentication (overrides profile)')
    .action(withErrorHandling(async (packageName: string | undefined, targetDir: string, options: InstallOptions) => {
      options.platforms = normalizePlatforms(options.platforms);

      const commandOptions = options as InstallOptions & { conflicts?: string };
      const rawConflictStrategy = commandOptions.conflicts ?? options.conflictStrategy;
      if (rawConflictStrategy) {
        const normalizedStrategy = (rawConflictStrategy as string).toLowerCase();
        const allowedStrategies: InstallOptions['conflictStrategy'][] = ['keep-both', 'overwrite', 'skip', 'ask'];
        if (!allowedStrategies.includes(normalizedStrategy as InstallOptions['conflictStrategy'])) {
          throw new Error(`Invalid --conflicts value '${rawConflictStrategy}'. Use one of: keep-both, overwrite, skip, ask.`);
        }
        options.conflictStrategy = normalizedStrategy as InstallOptions['conflictStrategy'];
      }

      validateResolutionFlags(options);
      options.resolutionMode = determineResolutionMode(options);

      const result = await installCommand(packageName, targetDir, options);
      if (!result.success) {
        if (result.error === 'Package not found') {
          return;
        }
        throw new Error(result.error || 'Installation operation failed');
      }
    }));
}

