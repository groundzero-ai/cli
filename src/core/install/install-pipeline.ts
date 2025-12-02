import type { CommandResult, InstallOptions } from '../../types/index.js';
import type { ResolvedPackage } from '../dependency-resolver.js';
import type { PackageRemoteResolutionOutcome, InstallResolutionMode } from './types.js';
import type { Platform } from '../platforms.js';

import { displayDependencyTree } from '../dependency-resolver.js';
import { ensureRegistryDirectories } from '../directory.js';
import { createPlatformDirectories } from '../platforms.js';
import { determineCanonicalInstallPlan, resolvePersistRange } from './canonical-plan.js';
import {
  prepareInstallEnvironment,
  resolveDependenciesForInstall,
  processConflictResolution,
  performIndexBasedInstallationPhases,
  VersionResolutionAbortError
} from './install-flow.js';
import { selectInstallVersionUnified } from './version-selection.js';
import { pullMissingDependenciesIfNeeded } from './remote-flow.js';
import { handleDryRunMode } from './dry-run.js';
import { displayInstallationResults, formatSelectionSummary } from './install-reporting.js';
import { buildNoVersionFoundError } from './install-errors.js';
import { createWorkspacePackageYml, addPackageToYml, writeLocalPackageFromRegistry } from '../../utils/package-management.js';
import { resolvePlatforms } from './platform-resolution.js';
import { getLocalPackageYmlPath, getInstallRootDir, isRootPackage } from '../../utils/paths.js';
import { exists } from '../../utils/fs.js';
import { logger } from '../../utils/logger.js';
import { PackageNotFoundError } from '../../utils/errors.js';

export interface InstallPipelineOptions extends InstallOptions {
  packageName: string;
  version?: string;
  targetDir: string;
}

export interface InstallPipelineResult {
  packageName: string;
  targetDir: string;
  resolvedPackages: ResolvedPackage[];
  totalPackages: number;
  installed: number;
  skipped: number;
  totalGroundzeroFiles: number;
}

export function determineResolutionMode(
  options: InstallOptions & { local?: boolean; remote?: boolean }
): InstallResolutionMode {
  if (options.resolutionMode) {
    return options.resolutionMode;
  }

  if ((options as any).remote) {
    return 'remote-primary';
  }

  if ((options as any).local) {
    return 'local-only';
  }

  return 'default';
}

export async function runInstallPipeline(
  options: InstallPipelineOptions
): Promise<CommandResult<InstallPipelineResult>> {
  const cwd = process.cwd();
  const resolutionMode = determineResolutionMode(options);
  const dryRun = Boolean(options.dryRun);
  const warnings: string[] = [];
  const warnedPackages = new Set<string>();

  if (await isRootPackage(cwd, options.packageName)) {
    console.log(`⚠️  Cannot install ${options.packageName} - it matches your project's root package name`);
    console.log(`   This would create a circular dependency.`);
    console.log(`💡 Tip: Use 'opkg install' without specifying a package name to install all packages referenced in your .openpackage/package.yml file.`);
    return {
      success: true,
      data: {
        packageName: options.packageName,
        targetDir: getInstallRootDir(cwd),
        resolvedPackages: [],
        totalPackages: 0,
        installed: 0,
        skipped: 1,
        totalGroundzeroFiles: 0
      }
    };
  }

  await ensureRegistryDirectories();
  await createWorkspacePackageYml(cwd);

  const canonicalPlan = await determineCanonicalInstallPlan({
    cwd,
    packageName: options.packageName,
    cliSpec: options.version,
    devFlag: options.dev ?? false
  });

  if (canonicalPlan.compatibilityMessage) {
    console.log(`ℹ️  ${canonicalPlan.compatibilityMessage}`);
  }

  const selectionOptions = options.stable ? { preferStable: true } : undefined;
  const preselection = await selectInstallVersionUnified({
    packageName: options.packageName,
    constraint: canonicalPlan.effectiveRange,
    mode: resolutionMode,
    selectionOptions,
    profile: options.profile,
    apiKey: options.apiKey
  });

  preselection.sources.warnings.forEach(message => {
    warnings.push(message);
    console.log(`⚠️  ${message}`);
    const match = message.match(/Remote pull failed for `([^`]+)`/);
    if (match) {
      warnedPackages.add(match[1]);
    }
  });

  const selectedRootVersion = preselection.selectedVersion;
  if (!selectedRootVersion) {
    throw buildNoVersionFoundError(
      options.packageName,
      canonicalPlan.effectiveRange,
      preselection.selection,
      resolutionMode
    );
  }

  const source: 'remote' | 'local' = preselection.resolutionSource ?? 'local';
  console.log(formatSelectionSummary(source, options.packageName, selectedRootVersion));

  const { specifiedPlatforms } = await prepareInstallEnvironment(cwd, options);

  const remoteOutcomes: Record<string, PackageRemoteResolutionOutcome> = {};

  const resolveDependenciesOutcome = async (): Promise<
    | { success: true; data: { resolvedPackages: ResolvedPackage[]; missingPackages: string[]; remoteOutcomes?: Record<string, PackageRemoteResolutionOutcome>; warnings?: string[] } }
    | { success: false; commandResult: CommandResult<InstallPipelineResult> }
  > => {
    try {
      const data = await resolveDependenciesForInstall(options.packageName, cwd, canonicalPlan.effectiveRange, {
        ...options,
        resolutionMode
      });
      if (data.warnings) {
        data.warnings.forEach(message => {
          warnings.push(message);
          console.log(`⚠️  ${message}`);
          const match = message.match(/Remote pull failed for `([^`]+)`/);
          if (match) {
            warnedPackages.add(match[1]);
          }
        });
      }
      return { success: true, data };
    } catch (error) {
      if (error instanceof VersionResolutionAbortError) {
        return {
          success: false,
          commandResult: { success: false, error: error.message }
        };
      }

      if (
        error instanceof PackageNotFoundError ||
        (error instanceof Error &&
          (error.message.includes('not available in local registry') ||
            (error.message.includes('Package') && error.message.includes('not found'))))
      ) {
        console.log('❌ Package not found');
        return { success: false, commandResult: { success: false, error: 'Package not found' } };
      }

      throw error;
    }
  };

  const initialResolution = await resolveDependenciesOutcome();
  if (!initialResolution.success) {
    return initialResolution.commandResult;
  }

  let resolvedPackages = initialResolution.data.resolvedPackages;
  let missingPackages = initialResolution.data.missingPackages;
  if (initialResolution.data.remoteOutcomes) {
    Object.assign(remoteOutcomes, initialResolution.data.remoteOutcomes);
  }

  if (missingPackages.length > 0) {
    if (resolutionMode === 'local-only') {
      logger.info('Local-only mode: missing dependencies will not be pulled from remote', {
        missingPackages: Array.from(new Set(missingPackages))
      });
    } else {
      const pullResult = await pullMissingDependenciesIfNeeded({
        missingPackages,
        resolvedPackages,
        remoteOutcomes,
        warnedPackages,
        dryRun,
        profile: options.profile,
        apiKey: options.apiKey
      });
      warnings.push(...pullResult.warnings);

      if (pullResult.pulledAny) {
        const refreshedResolution = await resolveDependenciesOutcome();
        if (!refreshedResolution.success) {
          return refreshedResolution.commandResult;
        }

        resolvedPackages = refreshedResolution.data.resolvedPackages;
        missingPackages = refreshedResolution.data.missingPackages;
        if (refreshedResolution.data.remoteOutcomes) {
          Object.assign(remoteOutcomes, refreshedResolution.data.remoteOutcomes);
        }
      }
    }
  }

  if (missingPackages.length > 0) {
    const missingSummary = `Missing packages: ${Array.from(new Set(missingPackages)).join(', ')}`;
    console.log(`⚠️  ${missingSummary}`);
    warnings.push(missingSummary);
  }

  const conflictProcessing = await processConflictResolution(resolvedPackages, options);
  if ('cancelled' in conflictProcessing) {
    console.log(`Installation cancelled by user`);
    return {
      success: true,
      data: {
        packageName: options.packageName,
        targetDir: getInstallRootDir(cwd),
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

  if (dryRun) {
    return await handleDryRunMode(
      finalResolvedPackages,
      options.packageName,
      options.targetDir,
      options,
      packageYmlExists
    );
  }

  const canPromptForPlatforms = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const finalPlatforms = options.resolvedPlatforms && options.resolvedPlatforms.length > 0
    ? options.resolvedPlatforms
    : await resolvePlatforms(cwd, specifiedPlatforms, { interactive: canPromptForPlatforms });
  const createdDirs = await createPlatformDirectories(cwd, finalPlatforms as Platform[]);

  const installationOutcome = await performIndexBasedInstallationPhases({
    cwd,
    packages: finalResolvedPackages,
    platforms: finalPlatforms as Platform[],
    conflictResult,
    options,
    targetDir: options.targetDir
  });

  for (const resolved of finalResolvedPackages) {
    await writeLocalPackageFromRegistry(cwd, resolved.name, resolved.version);
  }

  const mainPackage = finalResolvedPackages.find(pkg => pkg.isRoot);
  if (packageYmlExists && mainPackage) {
    const persistTarget = resolvePersistRange(canonicalPlan.persistDecision, mainPackage.version);
    if (persistTarget) {
      await addPackageToYml(
        cwd,
        options.packageName,
        mainPackage.version,
        persistTarget.target === 'dev-packages',
        persistTarget.range,
        true
      );
    }
  }

  displayInstallationResults(
    options.packageName,
    finalResolvedPackages,
    { platforms: finalPlatforms, created: createdDirs },
    options,
    mainPackage,
    installationOutcome.allAddedFiles,
    installationOutcome.allUpdatedFiles,
    installationOutcome.rootFileResults,
    missingPackages,
    remoteOutcomes
  );

  return {
    success: true,
    data: {
      packageName: options.packageName,
      targetDir: getInstallRootDir(cwd),
      resolvedPackages: finalResolvedPackages,
      totalPackages: finalResolvedPackages.length,
      installed: installationOutcome.installedCount,
      skipped: installationOutcome.skippedCount,
      totalGroundzeroFiles: installationOutcome.totalGroundzeroFiles
    },
    warnings: warnings.length > 0 ? Array.from(new Set(warnings)) : undefined
  };
}
