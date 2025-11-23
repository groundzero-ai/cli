import * as semver from 'semver';
import { Command } from 'commander';
import { InstallOptions, CommandResult, PackageYml } from '../types/index.js';
import { ResolvedPackage } from '../core/dependency-resolver.js';
import { ensureRegistryDirectories, hasPackageVersion, listPackageVersions } from '../core/directory.js';
import { displayDependencyTree } from '../core/dependency-resolver.js';
import { exists } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, UserCancellationError, PackageNotFoundError } from '../utils/errors.js';
import {
  type Platform,
} from '../constants/index.js';
import {
  createPlatformDirectories
} from '../core/platforms.js';
import { normalizePlatforms } from '../utils/platform-mapper.js';
import { resolvePlatforms } from '../core/install/platform-resolution.js';
import {
  prepareInstallEnvironment,
  resolveDependenciesForInstall,
  processConflictResolution,
  performIndexBasedInstallationPhases,
  type DependencyResolutionResult,
  VersionResolutionAbortError
} from '../core/install/install-flow.js';
import {
  getLocalPackageYmlPath,
  getAIDir,
  isRootPackage
} from '../utils/paths.js';
import { createBasicPackageYml, addPackageToYml, writeLocalPackageFromRegistry } from '../utils/package-management.js';
import {
  displayInstallationSummary,
  displayInstallationResults,
} from '../utils/package-installation.js';
import { planConflictsForPackage } from '../utils/index-based-installer.js';
import {
  withOperationErrorHandling,
} from '../utils/error-handling.js';
import { extractPackagesFromConfig } from '../utils/install-helpers.js';
import { parsePackageYml } from '../utils/package-yml.js';
import { parsePackageInput, arePackageNamesEquivalent } from '../utils/package-name.js';
import { packageManager } from '../core/package.js';
import { safePrompts } from '../utils/prompts.js';
import {
  createCaretRange,
  isExactVersion,
  isPrereleaseVersion,
  parseVersionRange,
  resolveVersionRange
} from '../utils/version-ranges.js';
import {
  fetchRemotePackageMetadata,
  pullDownloadsBatchFromRemote,
  aggregateRecursiveDownloads,
  type RemoteBatchPullResult,
} from '../core/remote-pull.js';
import { Spinner } from '../utils/spinner.js';
import { createDownloadKey, computeMissingDownloadKeys } from '../core/install/download-keys.js';
import { fetchMissingDependencyMetadata, pullMissingDependencies, planRemoteDownloadsForPackage } from '../core/install/remote-flow.js';
import { recordBatchOutcome, describeRemoteFailure } from '../core/install/remote-reporting.js';
import { handleDryRunMode } from '../core/install/dry-run.js';
import { InstallScenario, InstallResolutionMode } from '../core/install/types.js';
import { selectVersionForInstall } from '../core/install/version-selection.js';
import type { InstallVersionSelectionResult } from '../core/install/version-selection';

export function determineResolutionMode(options: InstallOptions & { local?: boolean; resolutionMode?: InstallResolutionMode }): InstallResolutionMode {
  if (options.resolutionMode) {
    return options.resolutionMode;
  }

  if (options.remote) {
    return 'remote-primary';
  }

  if (options.local) {
    return 'local-only';
  }

  return 'default';
}

export function validateResolutionFlags(options: InstallOptions & { local?: boolean; remote?: boolean }): void {
  if (options.remote && options.local) {
    throw new Error('--remote and --local cannot be used together. Choose one resolution mode.');
  }
}

export function selectInstallScenario(
  resolutionMode: InstallResolutionMode,
  mainPackageAvailableLocally: boolean
): InstallScenario {
  if (resolutionMode === 'remote-primary') {
    return 'force-remote';
  }

  if (resolutionMode === 'local-only') {
    return 'local-primary';
  }

  return mainPackageAvailableLocally ? 'local-primary' : 'remote-primary';
}

/**
 * Install all packages from CWD package.yml file
 * @param targetDir - Target directory for installation
 * @param options - Installation options including dev flag
 * @returns Command result with installation summary
 */
async function installAllPackagesCommand(
  targetDir: string,
  options: InstallOptions
): Promise<CommandResult> {
  const cwd = process.cwd();
  logger.info(`Installing all packages from package.yml to: ${getAIDir(cwd)}`, { options });
  
  await ensureRegistryDirectories();
  
  // Auto-create basic package.yml if it doesn't exist
  await createBasicPackageYml(cwd);
  
  const packageYmlPath = getLocalPackageYmlPath(cwd);
  
  const cwdConfig: PackageYml = await withOperationErrorHandling(
    () => parsePackageYml(packageYmlPath),
    'parse package.yml',
    packageYmlPath
  );
  
  const allPackagesToInstall = extractPackagesFromConfig(cwdConfig);

  // Filter out any packages that match the root package name
  const packagesToInstall = [];
  const skippedRootPackages = [];
  for (const pkg of allPackagesToInstall) {
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

  // Install packages sequentially to avoid conflicts
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
            const shouldPrompt = interactive && (!installOptions.conflictStrategy || installOptions.conflictStrategy === 'ask');

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

      const result = await installPackageCommand(
        pkg.name,
        targetDir,
        installOptions,
        pkg.version
      );
      
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
        throw error; // Re-throw to allow clean exit
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


/**
 * Install package command implementation with recursive dependency resolution
 * @param packageName - Name of the package to install
 * @param targetDir - Target directory for installation
 * @param options - Installation options including force, dry-run, and dev flags
 * @param version - Specific version to install (optional)
 * @returns Command result with detailed installation information
 */
async function installPackageCommand(
  packageName: string,
  targetDir: string,
  options: InstallOptions,
  version?: string
): Promise<CommandResult> {
  const cwd = process.cwd();

  const resolutionMode: InstallResolutionMode = options.resolutionMode ?? determineResolutionMode(options);

  // 1) Validate root package and early return
  if (await isRootPackage(cwd, packageName)) {
    console.log(`⚠️  Cannot install ${packageName} - it matches your project's root package name`);
    console.log(`   This would create a circular dependency.`);
    console.log(`💡 Tip: Use 'opkg install' without specifying a package name to install all packages`);
    console.log(`   referenced in your .openpackage/package.yml file.`);
    return {
      success: true,
      data: { skipped: true, reason: 'root package' }
    };
  }

  logger.debug(`Installing package '${packageName}' with dependencies to: ${getAIDir(cwd)}`, { options });

  const dryRun = !!options.dryRun;
  const forceRemote = resolutionMode === 'remote-primary';
  const warnings: string[] = [];

  const canonicalPlan = await determineCanonicalInstallPlan({
    cwd,
    packageName,
    cliSpec: version,
    devFlag: options.dev ?? false
  });

  if (canonicalPlan.compatibilityMessage) {
    console.log(`ℹ️  ${canonicalPlan.compatibilityMessage}`);
  }

  let versionConstraint = canonicalPlan.effectiveRange;

  const preselection = await selectVersionForInstall({
    packageName,
    constraint: versionConstraint,
    mode: resolutionMode,
    profile: options.profile,
    apiKey: options.apiKey
  });

  if (preselection.sources.warnings.length > 0) {
    preselection.sources.warnings.forEach(message => {
      warnings.push(message);
      console.log(`⚠️  ${message}`);
    });
  }

  const selectedRootVersion = preselection.selectedVersion;
  if (!selectedRootVersion) {
    const constraintLabel =
      canonicalPlan.dependencyState === 'existing' && canonicalPlan.canonicalRange
        ? canonicalPlan.canonicalRange
        : versionConstraint;
    throw buildNoVersionFoundError(packageName, constraintLabel, preselection.selection, resolutionMode);
  }

  if (preselection.selection.isPrerelease) {
    console.log(`ℹ️  Selected pre-release version ${selectedRootVersion} for ${packageName}`);
  }

  let downloadVersion = selectedRootVersion;

  const mainPackageAvailableLocally = downloadVersion
    ? await hasPackageVersion(packageName, downloadVersion)
    : await packageManager.packageExists(packageName);

  // 2) Determine install scenario
  const scenario = selectInstallScenario(resolutionMode, mainPackageAvailableLocally);

  // 3) Prepare env via prepareInstallEnvironment
  const { specifiedPlatforms } = await prepareInstallEnvironment(cwd, options);

  let resolvedPackages: ResolvedPackage[] = [];
  let missingPackages: string[] = [];

  const resolveDependenciesOutcome = async (): Promise<
    | { success: true; data: DependencyResolutionResult }
    | { success: false; commandResult: CommandResult }
  > => {
    try {
      const data = await resolveDependenciesForInstall(packageName, cwd, versionConstraint, options);
      if (data.warnings && data.warnings.length > 0) {
        data.warnings.forEach(message => warnings.push(message));
      }
      return { success: true, data };
    } catch (error) {
      if (error instanceof VersionResolutionAbortError) {
        return { success: false, commandResult: { success: false, error: error.message } };
      }

      if (
        error instanceof PackageNotFoundError ||
        (error instanceof Error && (
          error.message.includes('not available in local registry') ||
          (error.message.includes('Package') && error.message.includes('not found'))
        ))
      ) {
        console.log('❌ Package not found');
        return { success: false, commandResult: { success: false, error: 'Package not found' } };
      }

      throw error;
    }
  };

  // 4) Resolve deps via resolveDependenciesForInstall (wrapped helper retained locally)
  // 5) If scenario is local-primary and there are missing deps
  if (scenario === 'local-primary') {
    const initialResolution = await resolveDependenciesOutcome();
    if (!initialResolution.success) {
      return initialResolution.commandResult;
    }

    resolvedPackages = initialResolution.data.resolvedPackages;
    missingPackages = initialResolution.data.missingPackages;

    if (missingPackages.length > 0 && resolutionMode !== 'local-only') {

      // Fetch metadata via fetchMissingDependencyMetadata
      const metadataResults = await fetchMissingDependencyMetadata(missingPackages, resolvedPackages, { dryRun, profile: options.profile, apiKey: options.apiKey });

      if (metadataResults.length > 0) {
        // Build keysToDownload with computeMissingDownloadKeys
        const keysToDownload = new Set<string>();
        for (const metadata of metadataResults) {
          const aggregated = aggregateRecursiveDownloads([metadata.response]);
          const missingKeys = await computeMissingDownloadKeys(aggregated);
          missingKeys.forEach((key: string) => keysToDownload.add(key));
        }

        // Pull batches via pullMissingDependencies and log with recordBatchOutcome
        const batchResults = await pullMissingDependencies(metadataResults, keysToDownload, { dryRun, profile: options.profile, apiKey: options.apiKey });
        for (const batchResult of batchResults) {
          recordBatchOutcome('Pulled dependencies', batchResult, warnings, dryRun);
        }

        // Re-resolve deps
        const refreshedResolution = await resolveDependenciesOutcome();
        if (!refreshedResolution.success) {
          return refreshedResolution.commandResult;
        }

        resolvedPackages = refreshedResolution.data.resolvedPackages;
        missingPackages = refreshedResolution.data.missingPackages;
      }
    } else if (missingPackages.length > 0 && resolutionMode === 'local-only') {
      logger.info('Local-only mode: missing dependencies will not be pulled from remote', {
        missingPackages: Array.from(new Set(missingPackages))
      });
    }
  } else {
    // 6) Else (remote-primary / force-remote)

    // Fetch metadata for root
    const metadataSpinner = dryRun ? null : new Spinner('Fetching package metadata...');
    if (metadataSpinner) metadataSpinner.start();

    let metadataResult;
    try {
      metadataResult = await fetchRemotePackageMetadata(packageName, downloadVersion, { recursive: true, profile: options.profile, apiKey: options.apiKey });
    } finally {
      if (metadataSpinner) metadataSpinner.stop();
    }

    if (!metadataResult.success) {
      const requestedVersionLabel = downloadVersion ?? versionConstraint;
      const message = describeRemoteFailure(
        requestedVersionLabel ? `${packageName}@${requestedVersionLabel}` : packageName,
        metadataResult
      );
      console.log(`❌ ${message}`);
      return { success: false, error: metadataResult.reason === 'not-found' ? 'Package not found' : message };
    }

    // Decide which downloads to pull (respecting forceRemote, prompts, dryRun)
    const { downloadKeys, warnings: planWarnings } = await planRemoteDownloadsForPackage(metadataResult, { forceRemote, dryRun });
    warnings.push(...planWarnings);

    if (downloadKeys.size > 0 || dryRun) {
      const spinner = dryRun ? null : new Spinner(`Pulling ${downloadKeys.size} package(s) from remote registry...`);
      if (spinner) spinner.start();

      let batchResult: RemoteBatchPullResult;
      try {
        batchResult = await pullDownloadsBatchFromRemote(metadataResult.response, {
          httpClient: metadataResult.context.httpClient,
          profile: metadataResult.context.profile,
          dryRun,
          filter: (dependencyName, dependencyVersion) => {
            const key = createDownloadKey(dependencyName, dependencyVersion);
            if (!downloadKeys.has(key)) {
              return false;
            }

            if (dryRun) {
              return true;
            }

            downloadKeys.delete(key);
            return true;
          }
        });
      } finally {
        if (spinner) spinner.stop();
      }

      recordBatchOutcome('Pulled from remote', batchResult, warnings, dryRun);
    }

    // Resolve deps
    const finalResolution = await resolveDependenciesOutcome();
    if (!finalResolution.success) {
      return finalResolution.commandResult;
    }

    resolvedPackages = finalResolution.data.resolvedPackages;
    missingPackages = finalResolution.data.missingPackages;
  }

  // 7) Warn if still missing
  if (missingPackages.length > 0) {
    const missingSummary = `Missing packages after pull: ${Array.from(new Set(missingPackages)).join(', ')}`;
    console.log(`⚠️  ${missingSummary}`);
    warnings.push(missingSummary);
  }

  // 8) Process conflicts
  const conflictProcessing = await processConflictResolution(resolvedPackages, options);
  if ('cancelled' in conflictProcessing) {
    console.log(`Installation cancelled by user`);
    return {
      success: true,
      data: {
        packageName,
        targetDir: getAIDir(cwd),
        resolvedPackages: [],
        totalPackages: 0,
        installed: 0,
        skipped: 1,
        totalGroundzeroFiles: 0
      }
    };
  }

  const { finalResolvedPackages, conflictResult } = conflictProcessing;

  displayDependencyTree(finalResolvedPackages, true);

  const packageYmlPath = getLocalPackageYmlPath(cwd);
  const packageYmlExists = await exists(packageYmlPath);

  // 9) If dryRun, delegate to handleDryRunMode and return
  if (options.dryRun) {
    return await handleDryRunMode(finalResolvedPackages, packageName, targetDir, options, packageYmlExists);
  }

  // 10) Resolve platforms, create dirs, perform phases, write metadata, update package.yml, display results, return
  const canPromptForPlatforms = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const finalPlatforms = options.resolvedPlatforms && options.resolvedPlatforms.length > 0
    ? options.resolvedPlatforms
    : await resolvePlatforms(cwd, specifiedPlatforms, { interactive: canPromptForPlatforms });
  const createdDirs = await createPlatformDirectories(cwd, finalPlatforms as Platform[]);

  const mainPackage = finalResolvedPackages.find((f: any) => f.isRoot);

  const installationOutcome = await performIndexBasedInstallationPhases({
    cwd,
    packages: finalResolvedPackages,
    platforms: finalPlatforms as Platform[],
    conflictResult,
    options,
    targetDir
  });

  for (const resolved of finalResolvedPackages) {
    await writeLocalPackageFromRegistry(cwd, resolved.name, resolved.version);
  }

  if (packageYmlExists && mainPackage) {
    const persistTarget = resolvePersistRange(canonicalPlan.persistDecision, mainPackage.version);
    if (persistTarget) {
      await addPackageToYml(
        cwd,
        packageName,
        mainPackage.version,
        persistTarget.target === 'dev-packages',
        persistTarget.range,
        true
      );
    }
  }

  displayInstallationResults(
    packageName,
    finalResolvedPackages,
    { platforms: finalPlatforms, created: createdDirs },
    options,
    mainPackage,
    installationOutcome.allAddedFiles,
    installationOutcome.allUpdatedFiles,
    installationOutcome.rootFileResults,
    missingPackages
  );

  return {
    success: true,
    data: {
      packageName,
      targetDir: getAIDir(cwd),
      resolvedPackages: finalResolvedPackages,
      totalPackages: finalResolvedPackages.length,
      installed: installationOutcome.installedCount,
      skipped: installationOutcome.skippedCount,
      totalGroundzeroFiles: installationOutcome.totalGroundzeroFiles
    },
    warnings: warnings.length > 0 ? Array.from(new Set(warnings)) : undefined
  };
}


type DependencyTarget = 'packages' | 'dev-packages';

type PersistDecision =
  | { type: 'none' }
  | { type: 'explicit'; target: DependencyTarget; range: string }
  | { type: 'derive'; target: DependencyTarget; mode: 'caret-or-exact' };

interface CanonicalInstallPlan {
  effectiveRange: string;
  dependencyState: 'fresh' | 'existing';
  canonicalRange?: string;
  canonicalTarget?: DependencyTarget;
  persistDecision: PersistDecision;
  compatibilityMessage?: string;
}

interface CanonicalPlanArgs {
  cwd: string;
  packageName: string;
  cliSpec?: string;
  devFlag: boolean;
}

interface ParsedConstraint {
  resolverRange: string;
  displayRange: string;
}

async function determineCanonicalInstallPlan(args: CanonicalPlanArgs): Promise<CanonicalInstallPlan> {
  const normalizedCliSpec = args.cliSpec?.trim() || undefined;
  const existing = await findCanonicalDependency(args.cwd, args.packageName);

  const target: DependencyTarget = args.devFlag ? 'dev-packages' : 'packages';

  if (existing) {
    const canonicalConstraint = parseConstraintOrThrow('package', existing.range, args.packageName);

    if (normalizedCliSpec) {
      const cliConstraint = parseConstraintOrThrow('cli', normalizedCliSpec, args.packageName);
      if (!isRangeSubset(cliConstraint.resolverRange, canonicalConstraint.resolverRange)) {
        throw buildCanonicalConflictError(args.packageName, cliConstraint.displayRange, existing.range);
      }

      return {
        effectiveRange: canonicalConstraint.resolverRange,
        dependencyState: 'existing',
        canonicalRange: existing.range,
        canonicalTarget: existing.target,
        persistDecision: { type: 'none' },
        compatibilityMessage: `Using version range from package.yml (${existing.range}); CLI spec '${cliConstraint.displayRange}' is compatible.`
      };
    }

    return {
      effectiveRange: canonicalConstraint.resolverRange,
      dependencyState: 'existing',
      canonicalRange: existing.range,
      canonicalTarget: existing.target,
      persistDecision: { type: 'none' }
    };
  }

  if (normalizedCliSpec) {
    const cliConstraint = parseConstraintOrThrow('cli', normalizedCliSpec, args.packageName);
    return {
      effectiveRange: cliConstraint.resolverRange,
      dependencyState: 'fresh',
      persistDecision: {
        type: 'explicit',
        target,
        range: cliConstraint.displayRange
      }
    };
  }

  return {
    effectiveRange: '*',
    dependencyState: 'fresh',
    persistDecision: {
      type: 'derive',
      target,
      mode: 'caret-or-exact'
    }
  };
}

async function findCanonicalDependency(
  cwd: string,
  packageName: string
): Promise<{ range: string; target: DependencyTarget } | null> {
  const packageYmlPath = getLocalPackageYmlPath(cwd);
  if (!(await exists(packageYmlPath))) {
    return null;
  }

  try {
    const config = await parsePackageYml(packageYmlPath);
    const match =
      locateDependencyInArray(config.packages, packageName, 'packages') ||
      locateDependencyInArray(config['dev-packages'], packageName, 'dev-packages');
    return match;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${packageYmlPath}: ${detail}`);
  }
}

function locateDependencyInArray(
  deps: PackageYml['packages'],
  packageName: string,
  target: DependencyTarget
): { range: string; target: DependencyTarget } | null {
  if (!deps) {
    return null;
  }

  const entry = deps.find(dep => arePackageNamesEquivalent(dep.name, packageName));
  if (!entry) {
    return null;
  }

  if (!entry.version || !entry.version.trim()) {
    throw new Error(
      `Dependency '${packageName}' in .openpackage/package.yml must declare a version range. Edit the file and try again.`
    );
  }

  return {
    range: entry.version.trim(),
    target
  };
}

function parseConstraintOrThrow(source: 'cli' | 'package', raw: string, packageName: string): ParsedConstraint {
  try {
    const parsed = parseVersionRange(raw);
    return { resolverRange: parsed.range, displayRange: parsed.original };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (source === 'cli') {
      throw new Error(
        `Invalid version spec '${raw}' provided via CLI for '${packageName}'. ${message}. Adjust the CLI input and try again.`
      );
    }

    throw new Error(
      `Dependency '${packageName}' in .openpackage/package.yml has invalid version '${raw}'. ${message}. Edit the file and try again.`
    );
  }
}

function isRangeSubset(candidate: string, canonical: string): boolean {
  try {
    return semver.subset(candidate, canonical, { includePrerelease: true });
  } catch {
    return false;
  }
}

function buildCanonicalConflictError(packageName: string, cliSpec: string, canonicalRange: string): Error {
  return new Error(
    `Requested '${packageName}@${cliSpec}', but .openpackage/package.yml declares '${packageName}' with range '${canonicalRange}'. Edit package.yml to change the dependency line, then re-run opkg install.`
  );
}

function resolvePersistRange(
  decision: PersistDecision,
  selectedVersion: string
): { range: string; target: DependencyTarget } | null {
  if (decision.type === 'none') {
    return null;
  }

  if (decision.type === 'explicit') {
    return { range: decision.range, target: decision.target };
  }

  let derivedRange = selectedVersion;
  if (!(decision.mode === 'caret-or-exact' && isPrereleaseVersion(selectedVersion))) {
    derivedRange = createCaretRange(selectedVersion);
  }

  return { range: derivedRange, target: decision.target };
}

function buildNoVersionFoundError(
  packageName: string,
  constraint: string,
  selection: InstallVersionSelectionResult['selection'],
  mode: InstallResolutionMode
): Error {
  const stableList = formatVersionList(selection.availableStable);
  const prereleaseList = formatVersionList(selection.availablePrerelease);
  const suggestions = [
    'Edit .openpackage/package.yml or adjust the CLI range, then retry.',
    'Use opkg save/pack to create a compatible version in the local registry.'
  ];

  if (mode === 'local-only') {
    suggestions.push('Re-run without --local to include remote versions in resolution.');
  }

  const message = [
    `No version of '${packageName}' satisfies '${constraint}'.`,
    `Available stable versions: ${stableList}`,
    `Available WIP/pre-release versions: ${prereleaseList}`,
    'Suggested next steps:',
    ...suggestions.map(suggestion => `  • ${suggestion}`)
  ].join('\n');

  return new Error(message);
}

function formatVersionList(versions: string[]): string {
  if (!versions || versions.length === 0) {
    return 'none';
  }
  return versions.join(', ');
}


/**
 * Main install command router - handles both individual and bulk install
 * @param packageName - Name of package to install (optional, installs all if not provided)
 * @param targetDir - Target directory for installation
 * @param options - Installation options
 * @returns Command result with installation status and data
 */
async function installCommand(
  packageName: string | undefined,
  targetDir: string,
  options: InstallOptions
): Promise<CommandResult> {
  const mode = determineResolutionMode(options);
  options.resolutionMode = mode;
  logger.debug('Install resolution mode selected', { mode });

  // If no package name provided, install all from package.yml
  if (!packageName) {
    return await installAllPackagesCommand(targetDir, options);
  }

  // Parse package name and version from input
  const { name, version: inputVersion } = parsePackageInput(packageName);

  // Install the specific package with version
  return await installPackageCommand(name, targetDir, options, inputVersion);
}

/**
 * Setup the install command
 * @param program - Commander program instance to register the command with
 */
export function setupInstallCommand(program: Command): void {
  program
    .command('install')
    .alias('i')
    .description('Install packages from the local (and optional remote) registry into this workspace. Works with WIP copies from `opkg save` and stable releases from `opkg pack`.')
    .argument('[package-name]', 'name of the package to install (optional - installs all from package.yml if not specified). Supports package@version syntax.')
    .argument('[target-dir]', 'target directory relative to cwd/ai for /ai files only (defaults to ai root)', '.')
    .option('--dry-run', 'preview changes without applying them')
    .option('--force', 'overwrite existing files')
    .option('--conflicts <strategy>', 'conflict handling strategy: keep-both, overwrite, skip, or ask')
    .option('--dev', 'add package to dev-packages instead of packages')
    .option('--platforms <platforms...>', 'prepare specific platforms (e.g., cursor claudecode opencode)')
    .option('--remote', 'pull and install from remote registry, ignoring local versions')
    .option('--local', 'resolve and install using only local registry versions, skipping remote metadata and pulls')
    .option('--profile <profile>', 'profile to use for authentication')
    .option('--api-key <key>', 'API key for authentication (overrides profile)')
    .action(withErrorHandling(async (packageName: string | undefined, targetDir: string, options: InstallOptions) => {
      // Normalize platforms option early for downstream logic
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
          // Handled case: already printed minimal message, do not bubble to global handler
          return;
        }
        throw new Error(result.error || 'Installation operation failed');
      }
    }));
}