import * as semver from 'semver';
import { InstallOptions } from '../../types/index.js';
import { ResolvedPackage } from '../dependency-resolver.js';
import { ensureRegistryDirectories } from '../directory.js';
import { createPlatformDirectories } from '../platforms.js';
import { gatherGlobalVersionConstraints, gatherRootVersionConstraints } from '../openpackage.js';
import { resolveDependencies } from '../dependency-resolver.js';
import { resolveDependenciesWithOverrides } from '../../utils/install-helpers.js';
import { logger } from '../../utils/logger.js';
import { VersionConflictError, UserCancellationError } from '../../utils/errors.js';
import type { Platform } from '../../constants/index.js';
import { normalizePlatforms } from '../../utils/platform-mapper.js';
import { createBasicPackageYml, addPackageToYml } from '../../utils/package-management.js';
import { checkAndHandleAllPackageConflicts } from '../../utils/install-conflict-handler.js';
import { discoverAndCategorizeFiles } from '../../utils/install-file-discovery.js';
import { installAiFilesFromList } from '../../utils/install-orchestrator.js';
import { installRootFilesFromMap } from '../../utils/root-file-installer.js';
import { installPackageByIndex, type IndexInstallResult } from '../../utils/index-based-installer.js';
import { promptVersionSelection } from '../../utils/prompts.js';

export interface DependencyResolutionResult {
  resolvedPackages: ResolvedPackage[];
  missingPackages: string[];
}

export class VersionResolutionAbortError extends Error {
  constructor(public formulaName: string) {
    super(`Unable to resolve version for ${formulaName}`);
    this.name = 'VersionResolutionAbortError';
  }
}

export interface ConflictProcessingResult {
  finalResolvedPackages: ResolvedPackage[];
  conflictResult: ConflictSummary;
}

export interface InstallationPhasesParams {
  cwd: string;
  formulas: ResolvedPackage[];
  platforms: Platform[];
  conflictResult: ConflictSummary;
  options: InstallOptions;
  targetDir: string;
}

export interface InstallationPhasesResult {
  installedCount: number;
  skippedCount: number;
  allAddedFiles: string[];
  allUpdatedFiles: string[];
  rootFileResults: { installed: string[]; updated: string[]; skipped: string[] };
  totalGroundzeroFiles: number;
}

export interface GroundzeroPackageResult {
  name: string;
  filesInstalled: number;
  filesUpdated: number;
  installedFiles: string[];
  updatedFiles: string[];
  overwritten: boolean;
}

type ConflictSummary = Awaited<ReturnType<typeof checkAndHandleAllPackageConflicts>>;

/**
 * Handle formula availability outcomes and return appropriate command results
 */
/**
 * Prepare the installation environment by ensuring directories and basic files exist
 */
export async function prepareInstallEnvironment(
  cwd: string,
  options: InstallOptions
): Promise<{ specifiedPlatforms: string[] | undefined }> {
  await ensureRegistryDirectories();
  await createBasicPackageYml(cwd);

  const specifiedPlatforms = normalizePlatforms(options.platforms);

  if (specifiedPlatforms && specifiedPlatforms.length > 0 && !options.dryRun) {
    const earlyPlatforms = await resolvePlatforms(cwd, specifiedPlatforms, { interactive: false });
    await createPlatformDirectories(cwd, earlyPlatforms as Platform[]);
  }

  return { specifiedPlatforms };
}

/**
 * Resolve dependencies for installation with version conflict handling
 */
export async function resolveDependenciesForInstall(
  formulaName: string,
  cwd: string,
  version: string | undefined,
  options: InstallOptions
): Promise<DependencyResolutionResult> {
  const globalConstraints = await gatherGlobalVersionConstraints(cwd);
  const rootConstraints = await gatherRootVersionConstraints(cwd);

  try {
    const result = await resolveDependencies(
      formulaName,
      cwd,
      true,
      new Set(),
      new Map(),
      version,
      new Map(),
      globalConstraints,
      rootConstraints
    );

    return {
      resolvedPackages: result.resolvedPackages,
      missingPackages: result.missingPackages
    };
  } catch (error) {
    if (error instanceof VersionConflictError) {
      const conflictDetails: any = (error as any).details || {};
      const conflictName = conflictDetails.formulaName || conflictDetails.formula || formulaName;
      const available: string[] = conflictDetails.availableVersions || [];

      let chosenVersion: string | null = null;
      if (options.force) {
        chosenVersion = [...available].sort((a, b) => semver.rcompare(a, b))[0] || null;
      } else {
        chosenVersion = await promptVersionSelection(conflictName, available, 'to install');
      }

      if (!chosenVersion) {
        throw new VersionResolutionAbortError(conflictName);
      }

      await addPackageToYml(cwd, conflictName, chosenVersion, false, chosenVersion, true);

      const updatedConstraints = await gatherGlobalVersionConstraints(cwd);
      const overrideResult = await resolveDependenciesWithOverrides(
        formulaName,
        cwd,
        [],
        updatedConstraints,
        version
      );

      return {
        resolvedPackages: overrideResult.resolvedPackages,
        missingPackages: overrideResult.missingPackages
      };
    }

    throw error;
  }
}

/**
 * Process conflict resolution for all formulas in the dependency tree
 */
export async function processConflictResolution(
  resolvedPackages: ResolvedPackage[],
  options: InstallOptions
): Promise<ConflictProcessingResult | { cancelled: true }> {
  const conflictResult = await checkAndHandleAllPackageConflicts(resolvedPackages as any, options);

  if (!conflictResult.shouldProceed) {
    return { cancelled: true };
  }

  const finalResolvedPackages = resolvedPackages.filter(formula => !conflictResult.skippedPackages.includes(formula.name));

  return { finalResolvedPackages, conflictResult };
}


/**
 * Perform the index-based installation process
 */
export async function performIndexBasedInstallationPhases(params: InstallationPhasesParams): Promise<InstallationPhasesResult> {
  const { cwd, formulas, platforms, conflictResult, options, targetDir } = params;

  // Install each formula using index-based installer
  let totalInstalled = 0;
  let totalUpdated = 0;
  let totalDeleted = 0;
  let totalSkipped = 0;
  const allAddedFiles: string[] = [];
  const allUpdatedFiles: string[] = [];
  const allDeletedFiles: string[] = [];

  for (const resolved of formulas) {
    try {
      logger.debug(`Installing ${resolved.name}@${resolved.version} using index-based installer`);

      const installResult: IndexInstallResult = await installPackageByIndex(
        cwd,
        resolved.name,
        resolved.version,
        platforms,
        options
      );

      totalInstalled += installResult.installed;
      totalUpdated += installResult.updated;
      totalDeleted += installResult.deleted;
      totalSkipped += installResult.skipped;

      allAddedFiles.push(...installResult.installedFiles);
      allUpdatedFiles.push(...installResult.updatedFiles);
      allDeletedFiles.push(...installResult.deletedFiles);

      if (installResult.installed > 0 || installResult.updated > 0 || installResult.deleted > 0) {
        logger.info(`Index-based install for ${resolved.name}: ${installResult.installed} installed, ${installResult.updated} updated, ${installResult.deleted} deleted`);
      }
    } catch (error) {
      if (error instanceof UserCancellationError) {
        throw error; // Re-throw to allow clean exit
      }
      logger.error(`Failed index-based install for ${resolved.name}: ${error}`);
      totalSkipped++;
    }
  }

  // Handle root files separately
  const rootFileResults = {
    installed: new Set<string>(),
    updated: new Set<string>(),
    skipped: new Set<string>()
  };

  for (const resolved of formulas) {
    try {
      const categorized = await discoverAndCategorizeFiles(resolved.name, resolved.version, platforms);
      const installResult = await installRootFilesFromMap(
        cwd,
        resolved.name,
        categorized.rootFiles,
        platforms
      );

      installResult.installed.forEach(file => rootFileResults.installed.add(file));
      installResult.updated.forEach(file => rootFileResults.updated.add(file));
      installResult.skipped.forEach(file => rootFileResults.skipped.add(file));
    } catch (error) {
      if (error instanceof UserCancellationError) {
        throw error; // Re-throw to allow clean exit
      }
      logger.error(`Failed root file install for ${resolved.name}: ${error}`);
    }
  }

  return {
    installedCount: totalInstalled,
    skippedCount: totalSkipped,
    allAddedFiles,
    allUpdatedFiles,
    rootFileResults: {
      installed: Array.from(rootFileResults.installed),
      updated: Array.from(rootFileResults.updated),
      skipped: Array.from(rootFileResults.skipped)
    },
    totalGroundzeroFiles: totalInstalled + totalUpdated
  };
}

// Helper functions
function formatPackageLabel(formulaName: string, version?: string): string {
  return version ? `${formulaName}@${version}` : formulaName;
}

function getAIDir(cwd: string): string {
  return `${cwd}/ai`;
}

// Import the resolvePlatforms function from the platform-resolution file
import { resolvePlatforms } from './platform-resolution.js';
