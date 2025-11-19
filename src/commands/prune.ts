import { Command } from 'commander';
import * as semver from 'semver';
import { PruneOptions, CommandResult, PrereleaseVersion, PruneResult } from '../types/index.js';
import { ensureRegistryDirectories, listFormulaVersions, getFormulaVersionPath } from '../core/directory.js';
import { registryManager } from '../core/registry.js';
import { formulaManager } from '../core/formula.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, UserCancellationError } from '../utils/errors.js';
import { promptConfirmation } from '../utils/prompts.js';
import { isLocalVersion, extractBaseVersion } from '../utils/version-generator.js';
import { exists, getDirectorySize } from '../utils/fs.js';

/**
 * Extract timestamp from a prerelease version
 */
function extractTimestamp(version: string): number {
  if (!isLocalVersion(version)) {
    return 0;
  }

  // WIP versions are treated as the latest
  return Number.MAX_SAFE_INTEGER;
}

/**
 * Find all prerelease versions in the registry
 */
async function findPrereleaseVersions(formulaFilter?: string): Promise<PrereleaseVersion[]> {
  logger.debug('Finding prerelease versions', { formulaFilter });
  
  const formulas = await registryManager.listFormulas(undefined, true); // Get all versions, no filter yet
  const prereleaseVersions: PrereleaseVersion[] = [];
  
  for (const formula of formulas) {
    // Apply exact formula name filtering if provided
    if (formulaFilter && formula.name !== formulaFilter) {
      continue;
    }
    
    if (isLocalVersion(formula.version)) {
      const baseVersion = extractBaseVersion(formula.version);
      const timestamp = extractTimestamp(formula.version);
      const formulaPath = getFormulaVersionPath(formula.name, formula.version);
      
      prereleaseVersions.push({
        formulaName: formula.name,
        version: formula.version,
        baseVersion,
        timestamp,
        path: formulaPath
      });
    }
  }
  
  logger.debug(`Found ${prereleaseVersions.length} prerelease versions`);
  return prereleaseVersions;
}

/**
 * Get the latest base version for a formula (highest semver)
 * Considers both stable versions and base versions from prereleases
 */
async function getLatestBaseVersion(formulaName: string): Promise<string | null> {
  const allVersions = await listFormulaVersions(formulaName);
  const baseVersions = new Set<string>();
  
  for (const version of allVersions) {
    if (isLocalVersion(version)) {
      // Extract base version from prerelease version
      const baseVersion = extractBaseVersion(version);
      baseVersions.add(baseVersion);
    } else {
      // Add stable version directly
      baseVersions.add(version);
    }
  }
  
  if (baseVersions.size === 0) {
    return null;
  }
  
  return [...baseVersions].sort(semver.compare).pop()!;
}

/**
 * Group prerelease versions by formula
 */
function groupByFormula(versions: PrereleaseVersion[]): Map<string, PrereleaseVersion[]> {
  const groups = new Map<string, PrereleaseVersion[]>();
  
  for (const version of versions) {
    if (!groups.has(version.formulaName)) {
      groups.set(version.formulaName, []);
    }
    groups.get(version.formulaName)!.push(version);
  }
  
  return groups;
}

/**
 * Compare prerelease versions by timestamp (ascending order)
 */
function compareByTimestamp(a: PrereleaseVersion, b: PrereleaseVersion): number {
  return a.timestamp - b.timestamp;
}

/**
 * Analyze which versions to delete and preserve based on preservation rules
 */
async function analyzeDeletionSafety(
  versions: PrereleaseVersion[], 
  options: PruneOptions
): Promise<{ toDelete: PrereleaseVersion[], toPreserve: PrereleaseVersion[] }> {
  
  if (options.all) {
    return { toDelete: versions, toPreserve: [] };
  }
  
  const formulaGroups = groupByFormula(versions);
  const toDelete: PrereleaseVersion[] = [];
  const toPreserve: PrereleaseVersion[] = [];
  
  for (const [formulaName, formulaVersions] of formulaGroups) {
    // 1. Find the latest base version (highest semver)
    const latestBaseVersion = await getLatestBaseVersion(formulaName);
    
    if (!latestBaseVersion) {
      // No stable versions exist, delete all prereleases
      toDelete.push(...formulaVersions);
      continue;
    }
    
    // 2. Get prerelease versions ONLY for the latest base version
    const latestBasePrereleases = formulaVersions.filter(v => 
      v.baseVersion === latestBaseVersion
    );
    
    if (latestBasePrereleases.length > 0) {
      // 3. Preserve only the latest prerelease of the latest base version
      const sortedPrereleases = latestBasePrereleases.sort(compareByTimestamp);
      const latestPrerelease = sortedPrereleases[sortedPrereleases.length - 1]; // Get the last (latest) one
      toPreserve.push(latestPrerelease);
      
      // 4. Delete all other prereleases of the latest base version
      toDelete.push(...sortedPrereleases.slice(0, -1)); // All except the last one
    }
    
    // 5. Delete ALL prerelease versions of older base versions
    const olderBasePrereleases = formulaVersions.filter(v => 
      v.baseVersion !== latestBaseVersion
    );
    toDelete.push(...olderBasePrereleases);
  }
  
  return { toDelete, toPreserve };
}

/**
 * Calculate approximate size of directories to be deleted
 */
async function calculateFreedSpace(versions: PrereleaseVersion[]): Promise<number> {
  let totalSize = 0;
  
  for (const version of versions) {
    try {
      if (await exists(version.path)) {
        const size = await getDirectorySize(version.path);
        totalSize += size;
      }
    } catch (error) {
      logger.debug(`Failed to calculate size for ${version.path}`, { error });
    }
  }
  
  return totalSize;
}

/**
 * Format bytes to human readable string
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  
  return `${(bytes / Math.pow(k, i)).toFixed(1)} ${sizes[i]}`;
}

/**
 * Confirm prune operation with detailed breakdown
 */
async function confirmPruneOperation(
  toDelete: PrereleaseVersion[], 
  toPreserve: PrereleaseVersion[]
): Promise<void> {
  
  console.log('🔍 Prerelease Version Analysis:\n');
  
  // Show what will be preserved
  if (toPreserve.length > 0) {
    console.log('✅ Versions to PRESERVE (latest prerelease of latest base version):');
    const preserveGroups = groupByFormula(toPreserve);
    for (const [formulaName, versions] of preserveGroups) {
      for (const version of versions) {
        console.log(`   📦 ${formulaName}@${version.version} (latest prerelease of v${version.baseVersion})`);
      }
    }
    console.log();
  }
  
  // Show formulas with no prereleases for latest base version
  const deleteGroups = groupByFormula(toDelete);
  const preserveGroups = groupByFormula(toPreserve);
  const formulasWithoutLatestPrereleases = [...deleteGroups.keys()].filter(name => 
    !preserveGroups.has(name)
  );
  
  if (formulasWithoutLatestPrereleases.length > 0) {
    console.log('ℹ️  No prerelease versions found for latest base versions:');
    for (const formulaName of formulasWithoutLatestPrereleases) {
      const latestBase = await getLatestBaseVersion(formulaName);
      console.log(`   📦 ${formulaName} (latest: v${latestBase} - no prereleases)`);
    }
    console.log();
  }
  
  // Show what will be deleted
  if (toDelete.length > 0) {
    console.log('🗑️  Versions to DELETE:');
    
    for (const [formulaName, versions] of deleteGroups) {
      console.log(`   📦 ${formulaName} (${versions.length} versions):`);
      
      // Group by base version for better display
      const versionsByBase = new Map<string, PrereleaseVersion[]>();
      for (const version of versions) {
        if (!versionsByBase.has(version.baseVersion)) {
          versionsByBase.set(version.baseVersion, []);
        }
        versionsByBase.get(version.baseVersion)!.push(version);
      }
      
      // Sort base versions
      const sortedBases = [...versionsByBase.keys()].sort(semver.compare);
      
      for (const baseVersion of sortedBases) {
        const baseVersions = versionsByBase.get(baseVersion)!;
        const latestBase = await getLatestBaseVersion(formulaName);
        const isOlderBase = baseVersion !== latestBase;
        
        for (const version of baseVersions) {
          const reason = isOlderBase 
            ? `(older base: v${baseVersion})`
            : `(older prerelease of v${baseVersion})`;
          console.log(`      └─ ${version.version} ${reason}`);
        }
      }
    }
    console.log();
    
    // Calculate and show freed space
    const freedSpace = await calculateFreedSpace(toDelete);
    if (freedSpace > 0) {
      console.log(`💾 Estimated space to be freed: ~${formatBytes(freedSpace)}\n`);
    }
  }
  
  // Confirmation prompt
  const shouldProceed = await promptConfirmation(
    `Delete ${toDelete.length} prerelease version(s)?`,
    false  // Default to 'no' for safety
  );
  
  if (!shouldProceed) {
    throw new UserCancellationError();
  }
}

/**
 * Execute the prune operation
 */
async function executePruneOperation(versions: PrereleaseVersion[]): Promise<PruneResult> {
  const errors: string[] = [];
  const deletedVersions: PrereleaseVersion[] = [];
  const freedSpace = await calculateFreedSpace(versions);
  
  console.log('🧹 Cleaning up prerelease versions...\n');
  
  for (const version of versions) {
    try {
      await formulaManager.deleteFormulaVersion(version.formulaName, version.version);
      deletedVersions.push(version);
      console.log(`✓ Deleted ${version.formulaName}@${version.version}`);
    } catch (error) {
      const errorMsg = `Failed to delete ${version.formulaName}@${version.version}: ${error}`;
      errors.push(errorMsg);
      logger.error(errorMsg, { error, version });
      console.log(`✗ ${errorMsg}`);
    }
  }
  
  return {
    totalFound: versions.length,
    totalDeleted: deletedVersions.length,
    totalPreserved: 0, // Will be set by caller
    deletedVersions,
    preservedVersions: [], // Will be set by caller
    freedSpace,
    errors
  };
}

/**
 * Main prune command implementation
 */
async function pruneCommand(
  formulaName?: string,
  options: PruneOptions = {}
): Promise<CommandResult<PruneResult>> {
  logger.info(`Pruning prerelease versions${formulaName ? ` for formula: ${formulaName}` : ''}`);
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  try {
    // 1. Discovery phase
    const allPrereleaseVersions = await findPrereleaseVersions(formulaName);
    
    if (allPrereleaseVersions.length === 0) {
      const scope = formulaName ? `for formula '${formulaName}'` : 'in local registry';
      console.log(`No prerelease versions found ${scope}.`);
      
      const emptyResult: PruneResult = {
        totalFound: 0,
        totalDeleted: 0,
        totalPreserved: 0,
        deletedVersions: [],
        preservedVersions: [],
        freedSpace: 0,
        errors: []
      };
      
      return { success: true, data: emptyResult };
    }
    
    // 2. Safety analysis
    const { toDelete, toPreserve } = await analyzeDeletionSafety(allPrereleaseVersions, options);
    
    // 3. Dry run mode
    if (options.dryRun) {
      await confirmPruneOperation(toDelete, toPreserve);
      console.log('\n🔍 Dry run complete. Use \'opn prune\' without --dry-run to perform the cleanup.');
      
      const dryRunResult: PruneResult = {
        totalFound: allPrereleaseVersions.length,
        totalDeleted: 0,
        totalPreserved: toPreserve.length,
        deletedVersions: [],
        preservedVersions: toPreserve,
        freedSpace: await calculateFreedSpace(toDelete),
        errors: []
      };
      
      return { success: true, data: dryRunResult };
    }
    
    // 4. Confirmation (unless --force)
    if (!options.force && toDelete.length > 0) {
      await confirmPruneOperation(toDelete, toPreserve);
    }
    
    // 5. Execution
    if (toDelete.length === 0) {
      console.log('✨ No prerelease versions need to be pruned.');
      
      const noOpResult: PruneResult = {
        totalFound: allPrereleaseVersions.length,
        totalDeleted: 0,
        totalPreserved: toPreserve.length,
        deletedVersions: [],
        preservedVersions: toPreserve,
        freedSpace: 0,
        errors: []
      };
      
      return { success: true, data: noOpResult };
    }
    
    const result = await executePruneOperation(toDelete);
    result.totalPreserved = toPreserve.length;
    result.preservedVersions = toPreserve;
    
    // 6. Summary
    console.log('\n🎉 Cleanup complete!');
    console.log(`   📊 ${result.totalDeleted} prerelease version(s) deleted`);
    if (result.totalPreserved > 0) {
      console.log(`   ✅ ${result.totalPreserved} version(s) preserved`);
    }
    if (result.freedSpace > 0) {
      console.log(`   💾 ${formatBytes(result.freedSpace)} freed`);
    }
    if (result.errors.length > 0) {
      console.log(`   ⚠️  ${result.errors.length} error(s) occurred`);
    }
    
    return { success: true, data: result };
    
  } catch (error) {
    if (error instanceof UserCancellationError) {
      throw error; // Re-throw to be handled by withErrorHandling
    }
    
    logger.error('Failed to prune prerelease versions', { error, formulaName, options });
    throw error instanceof Error ? error : new Error(`Prune operation failed: ${error}`);
  }
}

/**
 * Setup the prune command
 */
export function setupPruneCommand(program: Command): void {
  program
    .command('prune')
    .description('Remove old prerelease versions from local registry. Preserves latest prerelease of latest version unless --all is specified.')
    .argument('[formula-name]', 'specific formula to prune (optional)')
    .option('--all', 'delete ALL prerelease versions including latest ones')
    .option('--dry-run', 'show what would be deleted without doing it')
    .option('-f, --force', 'skip confirmation prompts')
    .option('-i, --interactive', 'interactively select versions to delete')
    .action(withErrorHandling(async (formulaName?: string, options?: PruneOptions) => {
      const result = await pruneCommand(formulaName, options);
      if (!result.success) {
        throw new Error(result.error || 'Prune operation failed');
      }
    }));
}
