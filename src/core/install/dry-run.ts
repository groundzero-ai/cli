import type { InstallOptions, CommandResult } from '../../types/index.js';
import type { ResolvedPackage } from '../dependency-resolver.js';
import { CONFLICT_RESOLUTION } from '../../constants/index.js';
import { installAiFiles } from '../../utils/install-orchestrator.js';

/**
 * Handle dry run mode for package installation
 */
export async function handleDryRunMode(
  resolvedPackages: ResolvedPackage[],
  packageName: string,
  targetDir: string,
  options: InstallOptions,
  packageYmlExists: boolean
): Promise<CommandResult> {
  console.log(`✓ Dry run - showing what would be installed:\n`);

  const mainPackage = resolvedPackages.find(f => f.isRoot);
  if (mainPackage) {
    console.log(`Package: ${mainPackage.name} v${mainPackage.version}`);
    if (mainPackage.pkg.metadata.description) {
      console.log(`Description: ${mainPackage.pkg.metadata.description}`);
    }
    console.log('');
  }

  // Show what would be installed to ai
  for (const resolved of resolvedPackages) {
    if (resolved.conflictResolution === CONFLICT_RESOLUTION.SKIPPED) {
      console.log(`✓ Would skip ${resolved.name}@${resolved.version} (user would decline overwrite)`);
      continue;
    }

    if (resolved.conflictResolution === CONFLICT_RESOLUTION.KEPT) {
      console.log(`✓ Would skip ${resolved.name}@${resolved.version} (same or newer version already installed)`);
      continue;
    }

    const dryRunResult = await installAiFiles(resolved.name, targetDir, options, resolved.version, true);

    if (dryRunResult.skipped) {
      console.log(`✓ Would skip ${resolved.name}@${resolved.version} (same or newer version already installed)`);
      continue;
    }

    console.log(`✓ Would install to ai${targetDir !== '.' ? '/' + targetDir : ''}: ${dryRunResult.installedCount} files`);

    if (dryRunResult.overwritten) {
      console.log(`  ⚠️  Would overwrite existing directory`);
    }
  }

  // Show package.yml update
  if (packageYmlExists) {
    console.log(`\n✓ Would add to .openpackage/package.yml: ${packageName}@${resolvedPackages.find(f => f.isRoot)?.version}`);
  } else {
    console.log('\nNo .openpackage/package.yml found - skipping dependency addition');
  }

  return {
    success: true,
    data: {
      dryRun: true,
      resolvedPackages,
      totalPackages: resolvedPackages.length
    }
  };
}
