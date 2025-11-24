import * as yaml from 'js-yaml';
import * as semver from 'semver';
import { safePrompts } from '../utils/prompts.js';
import { PackageYml, Package } from '../types/index.js';
import { packageManager } from './package.js';
import { getInstalledPackageVersion, scanGroundzeroPackages } from './openpackage.js';
import { logger } from '../utils/logger.js';
import { PackageNotFoundError, PackageVersionNotFoundError, VersionConflictError } from '../utils/errors.js';
import { hasExplicitPrereleaseIntent, isExactVersion, selectVersionWithWipPolicy } from '../utils/version-ranges.js';
import { listPackageVersions } from './directory.js';
import { registryManager } from './registry.js';
import { gatherVersionSourcesForInstall } from './install/version-selection.js';
import { InstallResolutionMode } from './install/types.js';

/**
 * Resolved package interface for dependency resolution
 */
export interface ResolvedPackage {
  name: string;
  version: string;
  pkg: Package;
  isRoot: boolean;
  conflictResolution?: 'kept' | 'overwritten' | 'skipped';
  requiredVersion?: string; // The version required by the parent package
  requiredRange?: string; // The version range required by the parent package
}

/**
 * Dependency node interface for dependency tree operations
 */
export interface DependencyNode {
  name: string;
  version: string;
  dependencies: Set<string>;
  dependents: Set<string>;
  isProtected: boolean; // Listed in cwd package.yml
}

interface DependencyResolverOptions {
  mode?: InstallResolutionMode;
  profile?: string;
  apiKey?: string;
  onWarning?: (message: string) => void;
}

/**
 * Prompt user for overwrite confirmation
 */
export async function promptOverwrite(packageName: string, existingVersion: string, newVersion: string): Promise<boolean> {
  const response = await safePrompts({
    type: 'confirm',
    name: 'shouldOverwrite',
    message: `Package '${packageName}' conflict: existing v${existingVersion} vs required v${newVersion}. Overwrite with v${newVersion}?`,
    initial: true
  });
  
  return response.shouldOverwrite || false;
}

/**
 * Recursively resolve package dependencies for installation
 */
export async function resolveDependencies(
  packageName: string,
  targetDir: string,
  isRoot: boolean = true,
  visitedStack: Set<string> = new Set(),
  resolvedPackages: Map<string, ResolvedPackage> = new Map(),
  version?: string,
  requiredVersions: Map<string, string[]> = new Map(),
  globalConstraints?: Map<string, string[]>,
  rootOverrides?: Map<string, string[]>,
  resolverOptions: DependencyResolverOptions = {}
): Promise<{ resolvedPackages: ResolvedPackage[]; missingPackages: string[] }> {
  // Track missing dependencies for this invocation subtree
  const missing = new Set<string>();
  const resolutionMode: InstallResolutionMode = resolverOptions.mode ?? 'local-only';

  // 1. Cycle detection
  if (visitedStack.has(packageName)) {
    const cycle = Array.from(visitedStack);
    const cycleStart = cycle.indexOf(packageName);
    const actualCycle = cycle.slice(cycleStart).concat([packageName]);
    throw new Error(`❌ Circular dependency detected:\n   ${actualCycle.join(' → ')}\n\n💡 Review your package dependencies to break the cycle.`);
  }
  
  // 2. Resolve version range(s) to specific version if needed
  let resolvedVersion: string | undefined;
  let versionRange: string | undefined;

  // Precedence: root overrides (from root package.yml) > combined constraints
  let allRanges: string[] = [];

  if (rootOverrides?.has(packageName)) {
    // Root package.yml versions act as authoritative overrides
    allRanges = [...(rootOverrides.get(packageName)!)];
  } else {
    // No root override - combine all constraints
    if (version) {
      allRanges.push(version);
    }
    const globalRanges = globalConstraints?.get(packageName);
    if (globalRanges) {
      allRanges.push(...globalRanges);
    }
    const priorRanges = requiredVersions.get(packageName) || [];
    if (priorRanges.length > 0) {
      allRanges.push(...priorRanges);
    }
  }

  if (allRanges.length === 0) {
    // No constraints provided - resolvedVersion stays undefined so latest is used
  } else if (allRanges.length === 1 && isExactVersion(allRanges[0])) {
    resolvedVersion = allRanges[0];
    versionRange = allRanges[0];
  } else {
    const localVersions = await listPackageVersions(packageName);
    const versionSources = await gatherVersionSourcesForInstall({
      packageName,
      mode: resolutionMode,
      localVersions,
      profile: resolverOptions.profile,
      apiKey: resolverOptions.apiKey
    });

    if (versionSources.warnings.length > 0 && resolverOptions.onWarning) {
      versionSources.warnings.forEach(resolverOptions.onWarning);
    }

    const availableVersions = versionSources.availableVersions;
    if (availableVersions.length === 0) {
      missing.add(packageName);
      return { resolvedPackages: Array.from(resolvedPackages.values()), missingPackages: Array.from(missing) };
    }

    const satisfying = availableVersions.filter(versionCandidate => {
      return allRanges.every(range => {
        try {
          return semver.satisfies(versionCandidate, range, { includePrerelease: true });
        } catch (error) {
          logger.debug(`Failed to evaluate semver for ${packageName}@${versionCandidate} against range '${range}': ${error}`);
          return false;
        }
      });
    }).sort((a, b) => semver.rcompare(a, b));

    if (satisfying.length === 0) {
      throw new VersionConflictError(packageName, {
        ranges: allRanges,
        availableVersions
      });
    }

    const explicitPrereleaseIntent = allRanges.some(range => hasExplicitPrereleaseIntent(range));
    const selection = selectVersionWithWipPolicy(satisfying, '*', { explicitPrereleaseIntent });

    if (!selection.version) {
      throw new VersionConflictError(packageName, {
        ranges: allRanges,
        availableVersions
      });
    }

    resolvedVersion = selection.version;
    const deduped = Array.from(new Set(allRanges));
    versionRange = deduped.join(' & ');
    logger.debug(`Resolved constraints [${deduped.join(', ')}] to '${resolvedVersion}' for package '${packageName}'`);
  }

  // 3. Attempt to repair dependency from local registry
  let pkg: Package;
  try {
    // Load package with resolved version
    logger.debug(`Attempting to load package '${packageName}' from local registry`, {
      version: resolvedVersion,
      originalRange: versionRange
    });
    pkg = await packageManager.loadPackage(packageName, resolvedVersion);
    logger.debug(`Successfully loaded package '${packageName}' from local registry`, { version: pkg.metadata.version });
  } catch (error) {
    if (error instanceof PackageNotFoundError) {
      // Auto-repair attempt: Check if package exists in registry but needs to be loaded
      logger.debug(`Package '${packageName}' not found in local registry, attempting repair`);
      
      try {
        // Check if package exists in registry metadata (but files might be missing)
        const hasPackage = await registryManager.hasPackage(packageName);
        logger.debug(`Registry check for '${packageName}': hasPackage=${hasPackage}, requiredVersion=${version}`);
        
        if (hasPackage) {
          // Check if the resolved version exists (use resolvedVersion if available, otherwise fall back to version)
          const versionToCheck = resolvedVersion || version;
          if (versionToCheck) {
            const hasSpecificVersion = await registryManager.hasPackageVersion(packageName, versionToCheck);
            if (!hasSpecificVersion) {
              // Package exists but not in the required/resolved version - this is not a repairable error
              const dependencyChain = Array.from(visitedStack);
              const versionDisplay = versionRange || version || resolvedVersion;
              let errorMessage = `Package '${packageName}' exists in registry but version '${versionDisplay}' is not available\n\n`;
              
              if (dependencyChain.length > 0) {
                errorMessage += `📋 Dependency chain:\n`;
                for (let i = 0; i < dependencyChain.length; i++) {
                  const indent = '  '.repeat(i);
                  errorMessage += `${indent}└─ ${dependencyChain[i]}\n`;
                }
                errorMessage += `${'  '.repeat(dependencyChain.length)}└─ ${packageName}@${versionDisplay} ❌ (version not available)\n\n`;
              }
              
              errorMessage += `💡 To resolve this issue:\n`;
              errorMessage += `   • Install the available version: opkg install ${packageName}@latest\n`;
              errorMessage += `   • Update the dependency to use an available version\n`;
              errorMessage += `   • Create the required version locally: opkg init && opkg save\n`;
              
              throw new PackageVersionNotFoundError(errorMessage);
            }
          }
          
          logger.info(`Found package '${packageName}' in registry metadata, attempting repair`);
          // Try to reload the package metadata using resolved version (or original version if not resolved)
          const metadata = await registryManager.getPackageMetadata(packageName, resolvedVersion || version);
          // Attempt to load again with the resolved version - this might succeed if it was a temporary issue
          pkg = await packageManager.loadPackage(packageName, resolvedVersion || version);
          logger.info(`Successfully repaired and loaded package '${packageName}'`);
        } else {
          // Package truly doesn't exist - treat as missing dependency
          missing.add(packageName);
          return { resolvedPackages: Array.from(resolvedPackages.values()), missingPackages: Array.from(missing) };
        }
      } catch (repairError) {
        // If this is a version-specific error we created, re-throw it directly
        if (repairError instanceof PackageVersionNotFoundError) {
          throw repairError;
        }
        
        // Repair failed - treat as missing dependency
        missing.add(packageName);
        return { resolvedPackages: Array.from(resolvedPackages.values()), missingPackages: Array.from(missing) };
      }
    } else {
      // Re-throw other errors
      throw error;
    }
  }

  // Use the resolved version (from directory name) rather than metadata version
  // This ensures WIP packages use their full version string (e.g., 1.0.0-000fz8.a3k)
  // instead of the base version from package.yml (e.g., 1.0.0)
  const currentVersion = resolvedVersion;
  if (!currentVersion) {
    throw new Error(`Resolved version is undefined for package ${packageName}`);
  }
  
  // 3. Check for existing resolution
  const existing = resolvedPackages.get(packageName);
  if (existing) {
    const comparison = semver.compare(currentVersion, existing.version);
    
    if (comparison > 0) {
      // Current version is newer - prompt to overwrite
      const shouldOverwrite = await promptOverwrite(packageName, existing.version, currentVersion);
      if (shouldOverwrite) {
        existing.version = currentVersion;
        existing.pkg = pkg;
        existing.conflictResolution = 'overwritten';
      } else {
        existing.conflictResolution = 'skipped';
      }
    } else {
      // Existing version is same or newer - keep existing
      existing.conflictResolution = 'kept';
    }
    return { resolvedPackages: Array.from(resolvedPackages.values()), missingPackages: Array.from(missing) };
  }
  
  // 3.1. Check for already installed version in openpackage
  const installedVersion = await getInstalledPackageVersion(packageName, targetDir);
  if (installedVersion) {
    const comparison = semver.compare(currentVersion, installedVersion);
    
    if (comparison > 0) {
      // New version is greater than installed - allow installation but will prompt later
      logger.debug(`Package '${packageName}' will be upgraded from v${installedVersion} to v${currentVersion}`);
    } else if (comparison === 0) {
      // Same version - skip installation
      logger.debug(`Package '${packageName}' v${currentVersion} already installed, skipping`);
      resolvedPackages.set(packageName, {
        name: packageName,
        version: installedVersion,
        pkg,
        isRoot,
        conflictResolution: 'kept'
      });
      return { resolvedPackages: Array.from(resolvedPackages.values()), missingPackages: Array.from(missing) };
    } else {
      // New version is older than installed - skip installation
      logger.debug(`Package '${packageName}' has newer version installed (v${installedVersion} > v${currentVersion}), skipping`);
      resolvedPackages.set(packageName, {
        name: packageName,
        version: installedVersion,
        pkg,
        isRoot,
        conflictResolution: 'kept'
      });
      return { resolvedPackages: Array.from(resolvedPackages.values()), missingPackages: Array.from(missing) };
    }
  }
  
  // 4. Track required version if specified
  if (version) {
    if (!requiredVersions.has(packageName)) {
      requiredVersions.set(packageName, []);
    }
    requiredVersions.get(packageName)!.push(version);
  }

  // 5. Add to resolved map
  resolvedPackages.set(packageName, {
    name: packageName,
    version: currentVersion,
    pkg,
    isRoot,
    requiredVersion: resolvedVersion, // Track the resolved version
    requiredRange: versionRange // Track the original range
  });
  
  // 5. Parse dependencies from package's package.yml
  const packageYmlFile = pkg.files.find(f => f.path === 'package.yml');
  if (packageYmlFile) {
    const config = yaml.load(packageYmlFile.content) as PackageYml;
    
    // 6. Recursively resolve dependencies
    visitedStack.add(packageName);
    
    // Only process 'packages' array (NOT 'dev-packages' for transitive dependencies)
    const dependencies = config.packages || [];
    
    for (const dep of dependencies) {
      // Pass the required version from the dependency specification
      const child = await resolveDependencies(
        dep.name,
        targetDir,
        false,
        visitedStack,
        resolvedPackages,
        dep.version,
        requiredVersions,
        globalConstraints,
        rootOverrides,
        resolverOptions
      );
      for (const m of child.missingPackages) missing.add(m);
    }
    
    // For root package, also process dev-packages
    if (isRoot) {
      const devDependencies = config['dev-packages'] || [];
      for (const dep of devDependencies) {
        // Pass the required version from the dev dependency specification
        const child = await resolveDependencies(
          dep.name,
          targetDir,
          false,
          visitedStack,
          resolvedPackages,
          dep.version,
          requiredVersions,
          globalConstraints,
          rootOverrides,
          resolverOptions
        );
        for (const m of child.missingPackages) missing.add(m);
      }
    }
    
    visitedStack.delete(packageName);
  }
  
  // Attach the requiredVersions map to each resolved package for later use
  const resolvedArray = Array.from(resolvedPackages.values());
  for (const resolved of resolvedArray) {
    (resolved as any).requiredVersions = requiredVersions;
  }

  return { resolvedPackages: resolvedArray, missingPackages: Array.from(missing) };
}

/**
 * Display dependency tree to user
 */
export function displayDependencyTree(resolvedPackages: ResolvedPackage[], silent: boolean = false): void {
  if (silent) return;
  const root = resolvedPackages.find(f => f.isRoot);
  if (!root) return;
  
  console.log(`\n📦 Installing ${root.name}@${root.version} with dependencies:\n`);
  
  // Show root
  console.log(`${root.name}@${root.version} (root)`);
  
  // Show transitive dependencies
  const transitive = resolvedPackages.filter(f => !f.isRoot);
  for (const dep of transitive) {
    const status = dep.conflictResolution 
      ? ` (${dep.conflictResolution})`
      : '';
    
    // Show version range information if available
    const rangeInfo = dep.requiredRange && dep.requiredRange !== dep.version
      ? ` [from ${dep.requiredRange}]`
      : '';
    
    console.log(`├── ${dep.name}@${dep.version}${rangeInfo}${status}`);
  }
  
  console.log(`\n🔍 Total: ${resolvedPackages.length} packages\n`);
}

/**
 * Build dependency tree for all packages in openpackage (used by uninstall)
 */
export async function buildDependencyTree(openpackagePath: string, protectedPackages: Set<string>): Promise<Map<string, DependencyNode>> {
  const dependencyTree = new Map<string, DependencyNode>();
  
  // Use the shared scanGroundzeroPackages function
  const packages = await scanGroundzeroPackages(openpackagePath);
  
  // First pass: collect all packages and their dependencies
  for (const [packageName, pkg] of packages) {
    const dependencies = new Set<string>();
    
    // Collect dependencies from both packages and dev-packages
    const allDeps = [
      ...(pkg.packages || []),
      ...(pkg['dev-packages'] || [])
    ];
    
    for (const dep of allDeps) {
      dependencies.add(dep.name);
    }
    
    dependencyTree.set(packageName, {
      name: packageName,
      version: pkg.version,
      dependencies,
      dependents: new Set(),
      isProtected: protectedPackages.has(packageName)
    });
  }
  
  // Second pass: build dependents relationships
  for (const [packageName, node] of dependencyTree) {
    for (const depName of node.dependencies) {
      const depNode = dependencyTree.get(depName);
      if (depNode) {
        depNode.dependents.add(packageName);
      }
    }
  }
  
  return dependencyTree;
}

/**
 * Get all dependencies of a package recursively
 */
export async function getAllDependencies(packageName: string, dependencyTree: Map<string, DependencyNode>, visited: Set<string> = new Set()): Promise<Set<string>> {
  const allDeps = new Set<string>();
  
  if (visited.has(packageName)) {
    return allDeps; // Prevent infinite recursion
  }
  
  visited.add(packageName);
  const node = dependencyTree.get(packageName);
  
  if (node) {
    for (const dep of node.dependencies) {
      allDeps.add(dep);
      const subDeps = await getAllDependencies(dep, dependencyTree, visited);
      for (const subDep of subDeps) {
        allDeps.add(subDep);
      }
    }
  }
  
  visited.delete(packageName);
  return allDeps;
}

/**
 * Find dangling dependencies that can be safely removed (used by uninstall)
 */
export async function findDanglingDependencies(
  targetPackage: string,
  dependencyTree: Map<string, DependencyNode>
): Promise<Set<string>> {
  const danglingDeps = new Set<string>();
  
  // Get all dependencies of the target package
  const allDependencies = await getAllDependencies(targetPackage, dependencyTree);
  
  // Check each dependency to see if it's dangling
  for (const depName of allDependencies) {
    const depNode = dependencyTree.get(depName);
    if (!depNode) continue;
    
    // Skip if protected (listed in cwd package.yml)
    if (depNode.isProtected) {
      logger.debug(`Skipping protected package: ${depName}`);
      continue;
    }
    
    // Check if this dependency has any dependents outside the dependency tree being removed
    let hasExternalDependents = false;
    for (const dependent of depNode.dependents) {
      // If the dependent is not the target package and not in the dependency tree, it's external
      if (dependent !== targetPackage && !allDependencies.has(dependent)) {
        hasExternalDependents = true;
        break;
      }
    }
    
    // If no external dependents, it's dangling
    if (!hasExternalDependents) {
      danglingDeps.add(depName);
    }
  }
  
  return danglingDeps;
}
