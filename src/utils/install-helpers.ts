import * as semver from 'semver';
import { PackageYml } from '../types/index.js';
import { resolveDependencies, ResolvedPackage } from '../core/dependency-resolver.js';
import { gatherRootVersionConstraints } from '../core/openpackage.js';
import { arePackageNamesEquivalent } from './package-name.js';

/**
 * Extract packages from package.yml configuration
 */
export function extractPackagesFromConfig(config: PackageYml): Array<{ name: string; version?: string; isDev: boolean }> {
  const packages: Array<{ name: string; version?: string; isDev: boolean }> = [];
  
  // Extract regular packages
  if (config.packages) {
    for (const package of config.packages) {
      packages.push({
        name: package.name,
        version: package.version,
        isDev: false
      });
    }
  }
  
  // Extract dev packages
  if (config['dev-packages']) {
    for (const package of config['dev-packages']) {
      packages.push({
        name: package.name,
        version: package.version,
        isDev: true
      });
    }
  }
  
  return packages;
}

/**
 * Re-resolve dependencies with version overrides to ensure correct child dependencies
 */
export async function resolveDependenciesWithOverrides(
  packageName: string,
  targetDir: string,
  skippedPackages: string[],
  globalConstraints?: Map<string, string[]>,
  version?: string
): Promise<{ resolvedPackages: ResolvedPackage[]; missingPackages: string[] }> {
  // Re-gather root constraints (which now includes any newly persisted versions)
  const rootConstraints = await gatherRootVersionConstraints(targetDir);
  
  // Filter out skipped packages by creating a wrapper
  const customResolveDependencies = async (
    name: string,
    dir: string,
    isRoot: boolean = true,
    visitedStack: Set<string> = new Set(),
    resolvedPackages: Map<string, ResolvedPackage> = new Map(),
    ver?: string,
    requiredVersions: Map<string, string[]> = new Map(),
    globalConst?: Map<string, string[]>,
    rootOver?: Map<string, string[]>
  ): Promise<{ resolvedPackages: ResolvedPackage[]; missingPackages: string[] }> => {
    // Skip if this package is in the skipped list
    if (skippedPackages.includes(name)) {
      return { resolvedPackages: Array.from(resolvedPackages.values()), missingPackages: [] };
    }

    return await resolveDependencies(
      name,
      dir,
      isRoot,
      visitedStack,
      resolvedPackages,
      ver,
      requiredVersions,
      globalConst,
      rootOver
    );
  };
  
  // Re-resolve the entire dependency tree with updated root constraints
  return await customResolveDependencies(
    packageName,
    targetDir,
    true,
    new Set(),
    new Map(),
    version,
    new Map(),
    globalConstraints,
    rootConstraints
  );
}

/**
 * Get the highest version and required version of a package from the dependency tree
 */
export async function getVersionInfoFromDependencyTree(
  packageName: string,
  resolvedPackages: ResolvedPackage[]
): Promise<{ highestVersion: string; requiredVersion?: string }> {
  let highestVersion = '0.0.0';
  let highestRequiredVersion: string | undefined;
  
  // Get the requiredVersions map from the first resolved package
  const requiredVersions = (resolvedPackages[0] as any)?.requiredVersions as Map<string, string[]> | undefined;
  
  for (const resolved of resolvedPackages) {
    if (arePackageNamesEquivalent(resolved.name, packageName)) {
      if (semver.gt(resolved.version, highestVersion)) {
        highestVersion = resolved.version;
      }
    }
  }
  
  // Get the highest required version from all specified versions for this package
  if (requiredVersions && requiredVersions.has(packageName)) {
    const versions = requiredVersions.get(packageName)!;
    for (const version of versions) {
      if (!highestRequiredVersion || semver.gt(version, highestRequiredVersion)) {
        highestRequiredVersion = version;
      }
    }
  }
  
  return { highestVersion, requiredVersion: highestRequiredVersion };
}
