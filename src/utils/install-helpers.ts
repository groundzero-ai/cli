import * as semver from 'semver';
import { FormulaYml } from '../types/index.js';
import { resolveDependencies, ResolvedFormula } from '../core/dependency-resolver.js';
import { gatherRootVersionConstraints } from '../core/openpackage.js';
import { areFormulaNamesEquivalent } from './formula-name.js';

/**
 * Extract formulas from formula.yml configuration
 */
export function extractFormulasFromConfig(config: FormulaYml): Array<{ name: string; version?: string; isDev: boolean }> {
  const formulas: Array<{ name: string; version?: string; isDev: boolean }> = [];
  
  // Extract regular formulas
  if (config.formulas) {
    for (const formula of config.formulas) {
      formulas.push({
        name: formula.name,
        version: formula.version,
        isDev: false
      });
    }
  }
  
  // Extract dev formulas
  if (config['dev-formulas']) {
    for (const formula of config['dev-formulas']) {
      formulas.push({
        name: formula.name,
        version: formula.version,
        isDev: true
      });
    }
  }
  
  return formulas;
}

/**
 * Re-resolve dependencies with version overrides to ensure correct child dependencies
 */
export async function resolveDependenciesWithOverrides(
  formulaName: string,
  targetDir: string,
  skippedFormulas: string[],
  globalConstraints?: Map<string, string[]>,
  version?: string
): Promise<{ resolvedFormulas: ResolvedFormula[]; missingFormulas: string[] }> {
  // Re-gather root constraints (which now includes any newly persisted versions)
  const rootConstraints = await gatherRootVersionConstraints(targetDir);
  
  // Filter out skipped formulas by creating a wrapper
  const customResolveDependencies = async (
    name: string,
    dir: string,
    isRoot: boolean = true,
    visitedStack: Set<string> = new Set(),
    resolvedFormulas: Map<string, ResolvedFormula> = new Map(),
    ver?: string,
    requiredVersions: Map<string, string[]> = new Map(),
    globalConst?: Map<string, string[]>,
    rootOver?: Map<string, string[]>
  ): Promise<{ resolvedFormulas: ResolvedFormula[]; missingFormulas: string[] }> => {
    // Skip if this formula is in the skipped list
    if (skippedFormulas.includes(name)) {
      return { resolvedFormulas: Array.from(resolvedFormulas.values()), missingFormulas: [] };
    }

    return await resolveDependencies(
      name,
      dir,
      isRoot,
      visitedStack,
      resolvedFormulas,
      ver,
      requiredVersions,
      globalConst,
      rootOver
    );
  };
  
  // Re-resolve the entire dependency tree with updated root constraints
  return await customResolveDependencies(
    formulaName,
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
 * Get the highest version and required version of a formula from the dependency tree
 */
export async function getVersionInfoFromDependencyTree(
  formulaName: string,
  resolvedFormulas: ResolvedFormula[]
): Promise<{ highestVersion: string; requiredVersion?: string }> {
  let highestVersion = '0.0.0';
  let highestRequiredVersion: string | undefined;
  
  // Get the requiredVersions map from the first resolved formula
  const requiredVersions = (resolvedFormulas[0] as any)?.requiredVersions as Map<string, string[]> | undefined;
  
  for (const resolved of resolvedFormulas) {
    if (areFormulaNamesEquivalent(resolved.name, formulaName)) {
      if (semver.gt(resolved.version, highestVersion)) {
        highestVersion = resolved.version;
      }
    }
  }
  
  // Get the highest required version from all specified versions for this formula
  if (requiredVersions && requiredVersions.has(formulaName)) {
    const versions = requiredVersions.get(formulaName)!;
    for (const version of versions) {
      if (!highestRequiredVersion || semver.gt(version, highestRequiredVersion)) {
        highestRequiredVersion = version;
      }
    }
  }
  
  return { highestVersion, requiredVersion: highestRequiredVersion };
}
