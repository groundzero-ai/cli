import type { CommandResult, InstallOptions, PackageYml } from '../../types/index.js';

import { ensureRegistryDirectories, listPackageVersions } from '../directory.js';
import { createWorkspacePackageYml } from '../../utils/package-management.js';
import { getLocalPackageYmlPath } from '../../utils/paths.js';
import { parsePackageYml } from '../../utils/package-yml.js';
import { withOperationErrorHandling } from '../../utils/error-handling.js';
import { UserCancellationError } from '../../utils/errors.js';
import { extractPackagesFromConfig } from '../../utils/install-helpers.js';
import { isRootPackage } from '../../utils/paths.js';
import { logger } from '../../utils/logger.js';
import { normalizePlatforms } from '../../utils/platform-mapper.js';
import { resolvePlatforms } from './platform-resolution.js';
import { runInstallPipeline } from './install-pipeline.js';
import { displayInstallationSummary } from './install-reporting.js';
import { planConflictsForPackage } from '../../utils/index-based-installer.js';
import { safePrompts } from '../../utils/prompts.js';
import { resolveVersionRange, isExactVersion } from '../../utils/version-ranges.js';

interface BulkPackageEntry {
  name: string;
  version?: string;
  isDev: boolean;
}

export async function runBulkInstallPipeline(
  targetDir: string,
  options: InstallOptions
): Promise<CommandResult> {
  const cwd = process.cwd();

  await ensureRegistryDirectories();
  await createWorkspacePackageYml(cwd);

  const packageYmlPath = getLocalPackageYmlPath(cwd);
  const cwdConfig: PackageYml = await withOperationErrorHandling(
    () => parsePackageYml(packageYmlPath),
    'parse package.yml',
    packageYmlPath
  );

  const allPackages = extractPackagesFromConfig(cwdConfig);
  const packagesToInstall: BulkPackageEntry[] = [];
  const skippedRootPackages: BulkPackageEntry[] = [];

  for (const pkg of allPackages) {
    if (await isRootPackage(cwd, pkg.name)) {
      skippedRootPackages.push(pkg);
      console.log(`⚠️  Skipping ${pkg.name} - it matches your project's root package name`);
    } else {
      packagesToInstall.push(pkg);
    }
  }

  if (packagesToInstall.length === 0) {
    if (skippedRootPackages.length > 0) {
      console.log('✓ All packages in package.yml were skipped (matched root package)');
      console.log('\nTips:');
      console.log('• Root packages cannot be installed as dependencies');
      console.log('• Use "opkg install <package-name>" to install external packages');
      console.log('• Use "opkg save" to create a WIP copy of your root package in the registry');
    } else {
      console.log('⚠️ No packages found in package.yml');
      console.log('\nTips:');
      console.log('• Add packages to the "packages" array in package.yml');
      console.log('• Add development packages to the "dev-packages" array in package.yml');
      console.log('• Use "opkg install <package-name>" to install a specific package');
    }

    return { success: true, data: { installed: 0, skipped: skippedRootPackages.length } };
  }

  console.log(`✓ Installing ${packagesToInstall.length} packages from package.yml:`);
  packagesToInstall.forEach(pkg => {
    const prefix = pkg.isDev ? '[dev] ' : '';
    const label = pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name;
    console.log(`  • ${prefix}${label}`);
  });
  if (skippedRootPackages.length > 0) {
    console.log(`  • ${skippedRootPackages.length} packages skipped (matched root package)`);
  }
  console.log('');

  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const normalizedPlatforms = normalizePlatforms(options.platforms);
  const resolvedPlatforms = await resolvePlatforms(cwd, normalizedPlatforms, { interactive });

  let totalInstalled = 0;
  let totalSkipped = 0;
  const results: Array<{ name: string; success: boolean; error?: string }> = [];
  const aggregateWarnings = new Set<string>();

  for (const pkg of packagesToInstall) {
    try {
      const label = pkg.version ? `${pkg.name}@${pkg.version}` : pkg.name;

      const baseConflictDecisions = options.conflictDecisions
        ? { ...options.conflictDecisions }
        : undefined;

      const installOptions: InstallOptions = {
        ...options,
        dev: pkg.isDev,
        resolvedPlatforms,
        conflictDecisions: baseConflictDecisions
      };

      let conflictPlanningVersion = pkg.version;
      if (pkg.version && !isExactVersion(pkg.version)) {
        try {
          const localVersions = await listPackageVersions(pkg.name);
          conflictPlanningVersion = resolveVersionRange(pkg.version, localVersions) ?? undefined;
        } catch {
          conflictPlanningVersion = undefined;
        }
      }

      if (conflictPlanningVersion) {
        try {
          const conflicts = await planConflictsForPackage(
            cwd,
            pkg.name,
            conflictPlanningVersion,
            resolvedPlatforms
          );

          if (conflicts.length > 0) {
            const shouldPrompt =
              interactive &&
              (!installOptions.conflictStrategy || installOptions.conflictStrategy === 'ask');

            if (shouldPrompt) {
              console.log(`\n⚠️  Detected ${conflicts.length} potential file conflict${conflicts.length === 1 ? '' : 's'} for ${label}.`);
              const preview = conflicts.slice(0, 5);
              for (const conflict of preview) {
                const ownerInfo = conflict.ownerPackage ? `owned by ${conflict.ownerPackage}` : 'already exists locally';
                console.log(`  • ${conflict.relPath} (${ownerInfo})`);
              }
              if (conflicts.length > preview.length) {
                console.log(`  • ... and ${conflicts.length - preview.length} more`);
              }

              const selection = await safePrompts({
                type: 'select',
                name: 'strategy',
                message: `Choose conflict handling for ${label}:`,
                choices: [
                  { title: 'Keep both (rename existing files)', value: 'keep-both' },
                  { title: 'Overwrite existing files', value: 'overwrite' },
                  { title: 'Skip conflicting files', value: 'skip' },
                  { title: 'Review individually', value: 'ask' }
                ],
                initial: installOptions.conflictStrategy === 'ask' ? 3 : 0
              });

              const chosenStrategy = (selection as any).strategy as InstallOptions['conflictStrategy'];
              installOptions.conflictStrategy = chosenStrategy;

              if (chosenStrategy === 'ask') {
                const decisions: Record<string, 'keep-both' | 'overwrite' | 'skip'> = {};
                for (const conflict of conflicts) {
                  const detail = await safePrompts({
                    type: 'select',
                    name: 'decision',
                    message: `${conflict.relPath}${conflict.ownerPackage ? ` (owned by ${conflict.ownerPackage})` : ''}:`,
                    choices: [
                      { title: 'Keep both (rename existing)', value: 'keep-both' },
                      { title: 'Overwrite existing', value: 'overwrite' },
                      { title: 'Skip (keep existing)', value: 'skip' }
                    ],
                    initial: 0
                  });
                  const decisionValue = (detail as any).decision as 'keep-both' | 'overwrite' | 'skip';
                  decisions[conflict.relPath] = decisionValue;
                }
                installOptions.conflictDecisions = decisions;
              }
            } else if (!interactive && (!installOptions.conflictStrategy || installOptions.conflictStrategy === 'ask')) {
              logger.warn(
                `Detected ${conflicts.length} potential conflict${conflicts.length === 1 ? '' : 's'} for ${label}, but running in non-interactive mode. Conflicting files will be skipped unless '--conflicts' is provided.`
              );
            }
          }
        } catch (planError) {
          logger.warn(`Failed to evaluate conflicts for ${label}: ${planError}`);
        }
      }

      console.log(`\n🔧 Installing ${pkg.isDev ? '[dev] ' : ''}${label}...`);

      const result = await runInstallPipeline({
        ...installOptions,
        packageName: pkg.name,
        version: pkg.version,
        targetDir
      });

      if (result.success) {
        totalInstalled++;
        results.push({ name: pkg.name, success: true });
        console.log(`✓ Successfully installed ${pkg.name}`);

        if (result.warnings && result.warnings.length > 0) {
          result.warnings.forEach(warning => aggregateWarnings.add(warning));
        }
      } else {
        totalSkipped++;
        results.push({ name: pkg.name, success: false, error: result.error });
        console.log(`❌ Failed to install ${pkg.name}: ${result.error}`);
      }
    } catch (error) {
      if (error instanceof UserCancellationError) {
        throw error;
      }
      totalSkipped++;
      results.push({ name: pkg.name, success: false, error: String(error) });
      console.log(`❌ Failed to install ${pkg.name}: ${error}`);
    }
  }

  displayInstallationSummary(totalInstalled, totalSkipped, packagesToInstall.length, results);

  if (aggregateWarnings.size > 0) {
    console.log('\n⚠️  Warnings during installation:');
    aggregateWarnings.forEach(warning => {
      console.log(`  • ${warning}`);
    });
  }

  const allSuccessful = totalSkipped === 0;

  return {
    success: allSuccessful,
    data: {
      installed: totalInstalled,
      skipped: totalSkipped,
      results
    },
    error: allSuccessful ? undefined : `${totalSkipped} packages failed to install`,
    warnings: totalSkipped > 0 ? [`${totalSkipped} packages failed to install`] : undefined
  };
}

