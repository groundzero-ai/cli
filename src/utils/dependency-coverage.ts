import { exists } from './fs.js';
import { parsePackageYml } from './package-yml.js';
import { getLocalPackageYmlPath } from './paths.js';
import { extractPackagesFromConfig } from './install-helpers.js';
import { normalizePackageName } from './package-name.js';
import { gatherGlobalVersionConstraints, gatherRootVersionConstraints } from '../core/openpackage.js';
import { resolveDependencies } from '../core/dependency-resolver.js';
import { logger } from './logger.js';
import { PackageYml } from '../types/index.js';

export interface DependencyCoverage {
  direct: Set<string>;
  transitive: Set<string>;
}

export async function getDependencyCoverage(cwd: string): Promise<DependencyCoverage> {
  const direct = new Set<string>();
  const transitive = new Set<string>();
  const formulaYmlPath = getLocalPackageYmlPath(cwd);

  if (!(await exists(formulaYmlPath))) {
    return { direct, transitive };
  }

  let config: PackageYml;
  try {
    config = await parsePackageYml(formulaYmlPath);
  } catch (error) {
    logger.warn(`Failed to parse main formula.yml while computing dependency coverage: ${error}`);
    return { direct, transitive };
  }

  const topLevel = extractPackagesFromConfig(config);
  if (topLevel.length === 0) {
    return { direct, transitive };
  }

  const globalConstraints = await gatherGlobalVersionConstraints(cwd);
  const rootConstraints = await gatherRootVersionConstraints(cwd);

  for (const dep of topLevel) {
    const normalizedName = normalizePackageName(dep.name);
    direct.add(normalizedName);

    try {
      const result = await resolveDependencies(
        dep.name,
        cwd,
        true,
        new Set(),
        new Map(),
        dep.version,
        new Map(),
        globalConstraints,
        rootConstraints
      );

      for (const resolved of result.resolvedPackages) {
        if (resolved.isRoot) {
          continue;
        }
        transitive.add(normalizePackageName(resolved.name));
      }
    } catch (error) {
      logger.debug(`Failed to resolve dependencies for ${dep.name} while computing coverage: ${error}`);
    }
  }

  for (const name of direct) {
    transitive.delete(name);
  }

  return { direct, transitive };
}

export async function isPackageTransitivelyCovered(cwd: string, formulaName: string): Promise<boolean> {
  const { transitive } = await getDependencyCoverage(cwd);
  return transitive.has(normalizePackageName(formulaName));
}

export async function isPackageCovered(
  cwd: string,
  formulaName: string,
  options?: { includeDirect?: boolean }
): Promise<boolean> {
  const coverage = await getDependencyCoverage(cwd);
  const normalized = normalizePackageName(formulaName);

  if (options?.includeDirect !== false && coverage.direct.has(normalized)) {
    return true;
  }

  return coverage.transitive.has(normalized);
}

