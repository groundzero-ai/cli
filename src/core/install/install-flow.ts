import * as semver from 'semver';
import { CommandResult, InstallOptions, FormulaYml } from '../../types/index.js';
import { ResolvedFormula } from '../dependency-resolver.js';
import { ensureRegistryDirectories } from '../directory.js';
import { createPlatformDirectories } from '../platforms.js';
import { gatherGlobalVersionConstraints, gatherRootVersionConstraints } from '../groundzero.js';
import { resolveDependencies } from '../dependency-resolver.js';
import { resolveDependenciesWithOverrides } from '../../utils/install-helpers.js';
import { exists } from '../../utils/fs.js';
import { logger } from '../../utils/logger.js';
import { VersionConflictError, UserCancellationError, FormulaNotFoundError } from '../../utils/errors.js';
import type { Platform } from '../../constants/index.js';
import { normalizePlatforms } from '../../utils/platform-mapper.js';
import { createBasicFormulaYml, addFormulaToYml } from '../../utils/formula-management.js';
import { checkAndHandleAllFormulaConflicts } from '../../utils/install-conflict-handler.js';
import { discoverAndCategorizeFiles } from '../../utils/install-file-discovery.js';
import { installFilesByIdWithMap } from '../../utils/id-based-installer.js';
import { installIndexYmlDirectories } from '../../utils/index-yml-based-installer.js';
import { installAiFilesFromList } from '../../utils/install-orchestrator.js';
import { installRootFilesFromMap } from '../../utils/root-file-installer.js';
import { promptVersionSelection } from '../../utils/prompts.js';

export interface DependencyResolutionResult {
  resolvedFormulas: ResolvedFormula[];
  missingFormulas: string[];
}

export class VersionResolutionAbortError extends Error {
  constructor(public formulaName: string) {
    super(`Unable to resolve version for ${formulaName}`);
    this.name = 'VersionResolutionAbortError';
  }
}

export interface ConflictProcessingResult {
  finalResolvedFormulas: ResolvedFormula[];
  conflictResult: ConflictSummary;
}

export interface InstallationPhasesParams {
  cwd: string;
  formulas: ResolvedFormula[];
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

export interface GroundzeroFormulaResult {
  name: string;
  filesInstalled: number;
  filesUpdated: number;
  installedFiles: string[];
  updatedFiles: string[];
  overwritten: boolean;
}

type ConflictSummary = Awaited<ReturnType<typeof checkAndHandleAllFormulaConflicts>>;

/**
 * Handle formula availability outcomes and return appropriate command results
 */
export function handleAvailabilityOutcome(
  availability: AvailabilityResult,
  formulaName: string,
  version: string | undefined,
  cwd: string,
  targetDir: string
): CommandResult | null {
  if (availability.status === 'not-found') {
    console.log(`❌ Formula '${formulaName}' not found in remote registry`);
    return { success: false, error: `Formula '${formulaName}' not found in remote registry` };
  }

  if (availability.status === 'failed') {
    return { success: false, error: availability.message || 'Failed to prepare formula for installation' };
  }

  if (availability.status === 'missing') {
    console.log(`Dry run: would pull ${formatFormulaLabel(formulaName, version)} from remote before installation.`);
    return {
      success: true,
      data: {
        formulaName,
        targetDir: getAIDir(cwd),
        resolvedFormulas: [],
        totalFormulas: 0,
        installed: 0,
        skipped: 1,
        totalGroundzeroFiles: 0,
        dryRun: true
      },
      warnings: [`Dry run: ${formatFormulaLabel(formulaName, version)} not installed (formula unavailable locally)`]
    };
  }

  return null;
}

/**
 * Prepare the installation environment by ensuring directories and basic files exist
 */
export async function prepareInstallEnvironment(
  cwd: string,
  options: InstallOptions
): Promise<{ specifiedPlatforms: string[] | undefined }> {
  await ensureRegistryDirectories();
  await createBasicFormulaYml(cwd);

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
      resolvedFormulas: result.resolvedFormulas,
      missingFormulas: result.missingFormulas
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

      await addFormulaToYml(cwd, conflictName, chosenVersion, false, chosenVersion, true);

      const updatedConstraints = await gatherGlobalVersionConstraints(cwd);
      const overrideResult = await resolveDependenciesWithOverrides(
        formulaName,
        cwd,
        [],
        updatedConstraints,
        version
      );

      return {
        resolvedFormulas: overrideResult.resolvedFormulas,
        missingFormulas: overrideResult.missingFormulas
      };
    }

    throw error;
  }
}

/**
 * Process conflict resolution for all formulas in the dependency tree
 */
export async function processConflictResolution(
  resolvedFormulas: ResolvedFormula[],
  options: InstallOptions
): Promise<ConflictProcessingResult | { cancelled: true }> {
  const conflictResult = await checkAndHandleAllFormulaConflicts(resolvedFormulas as any, options);

  if (!conflictResult.shouldProceed) {
    return { cancelled: true };
  }

  const finalResolvedFormulas = resolvedFormulas.filter(formula => !conflictResult.skippedFormulas.includes(formula.name));

  return { finalResolvedFormulas, conflictResult };
}

/**
 * Perform the multi-phase installation process
 */
export async function performInstallationPhases(params: InstallationPhasesParams): Promise<InstallationPhasesResult> {
  const { cwd, formulas, platforms, conflictResult, options, targetDir } = params;

  const categorizedByFormula = new Map<string, Awaited<ReturnType<typeof discoverAndCategorizeFiles>>>();
  for (const resolved of formulas) {
    const categorized = await discoverAndCategorizeFiles(resolved.name, resolved.version, platforms);
    categorizedByFormula.set(resolved.name, categorized);
  }

  let installedCount = 0;
  let skippedCount = 0;
  const allAddedFiles: string[] = [];
  const allUpdatedFiles: string[] = [];
  const groundzeroResults: GroundzeroFormulaResult[] = [];
  let indexInstalledTotal = 0;
  let indexUpdatedTotal = 0;

  for (const resolved of formulas) {
    const categorized = categorizedByFormula.get(resolved.name)!;
    if (categorized.idBasedFiles.size === 0) {
      continue;
    }

    try {
      const platformResult = await installFilesByIdWithMap(
        cwd,
        resolved.name,
        resolved.version,
        platforms,
        categorized.idBasedFiles,
        options,
        conflictResult.forceOverwriteFormulas.has(resolved.name)
      );

      if (platformResult.installed > 0 || platformResult.updated > 0) {
        installedCount++;
        groundzeroResults.push({
          name: resolved.name,
          filesInstalled: platformResult.installed,
          filesUpdated: platformResult.updated,
          installedFiles: platformResult.installedFiles,
          updatedFiles: platformResult.updatedFiles,
          overwritten: platformResult.updated > 0
        });
      }
    } catch (error) {
      logger.error(`Failed ID-based install for ${resolved.name}: ${error}`);
      skippedCount++;
    }
  }

  for (const resolved of formulas) {
    const categorized = categorizedByFormula.get(resolved.name)!;
    if (categorized.indexYmlDirs.length === 0) {
      continue;
    }

    const indexResult = await installIndexYmlDirectories(
      cwd,
      categorized.indexYmlDirs,
      platforms,
      options
    );

    indexInstalledTotal += indexResult.installed;
    indexUpdatedTotal += indexResult.updated;
    allAddedFiles.push(...indexResult.installedFiles);
    allUpdatedFiles.push(...indexResult.updatedFiles);
  }

  for (const resolved of formulas) {
    const categorized = categorizedByFormula.get(resolved.name)!;
    const aiFiles = categorized.pathBasedFiles.filter(file => file.path.startsWith('ai/'));
    if (aiFiles.length === 0) {
      continue;
    }

    const aiResult = await installAiFilesFromList(
      cwd,
      targetDir,
      aiFiles,
      options,
      conflictResult.forceOverwriteFormulas.has(resolved.name)
    );

    if (!aiResult.skipped && aiResult.installedCount > 0) {
      installedCount++;
      const relativeInstalledFiles = aiResult.files.map(filePath => filePath.replace(`${cwd}/`, ''));
      const existing = groundzeroResults.find(result => result.name === resolved.name);

      if (existing) {
        existing.filesInstalled += aiResult.installedCount;
        existing.installedFiles.push(...relativeInstalledFiles);
        existing.overwritten = existing.overwritten || aiResult.overwritten;
      } else {
        groundzeroResults.push({
          name: resolved.name,
          filesInstalled: aiResult.installedCount,
          filesUpdated: 0,
          installedFiles: relativeInstalledFiles,
          updatedFiles: [],
          overwritten: aiResult.overwritten
        });
      }
    }
  }

  const rootFileResults = {
    installed: new Set<string>(),
    updated: new Set<string>(),
    skipped: new Set<string>()
  };

  for (const resolved of formulas) {
    const categorized = categorizedByFormula.get(resolved.name)!;
    const installResult = await installRootFilesFromMap(
      cwd,
      resolved.name,
      categorized.rootFiles,
      platforms
    );

    installResult.installed.forEach(file => rootFileResults.installed.add(file));
    installResult.updated.forEach(file => rootFileResults.updated.add(file));
    installResult.skipped.forEach(file => rootFileResults.skipped.add(file));
  }

  groundzeroResults.forEach(result => {
    allAddedFiles.push(...result.installedFiles);
    allUpdatedFiles.push(...result.updatedFiles);
  });

  const totalGroundzeroFiles =
    groundzeroResults.reduce((sum, result) => sum + result.filesInstalled + result.filesUpdated, 0) +
    indexInstalledTotal +
    indexUpdatedTotal;

  return {
    installedCount,
    skippedCount,
    allAddedFiles,
    allUpdatedFiles,
    rootFileResults: {
      installed: Array.from(rootFileResults.installed),
      updated: Array.from(rootFileResults.updated),
      skipped: Array.from(rootFileResults.skipped)
    },
    totalGroundzeroFiles
  };
}

// Helper functions
function formatFormulaLabel(formulaName: string, version?: string): string {
  return version ? `${formulaName}@${version}` : formulaName;
}

function getAIDir(cwd: string): string {
  return `${cwd}/ai`;
}

// Type definitions for imports
interface AvailabilityResult {
  status: 'local' | 'pulled' | 'missing' | 'not-found' | 'failed';
  message?: string;
}

// Import the resolvePlatforms function from the platform-resolution file
import { resolvePlatforms } from './platform-resolution.js';
