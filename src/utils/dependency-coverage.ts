import { exists } from './fs.js';
import { parseFormulaYml } from './formula-yml.js';
import { getLocalFormulaYmlPath } from './paths.js';
import { extractFormulasFromConfig } from './install-helpers.js';
import { normalizeFormulaName } from './formula-name.js';
import { gatherGlobalVersionConstraints, gatherRootVersionConstraints } from '../core/groundzero.js';
import { resolveDependencies } from '../core/dependency-resolver.js';
import { logger } from './logger.js';
import { FormulaYml } from '../types/index.js';

export interface DependencyCoverage {
  direct: Set<string>;
  transitive: Set<string>;
}

export async function getDependencyCoverage(cwd: string): Promise<DependencyCoverage> {
  const direct = new Set<string>();
  const transitive = new Set<string>();
  const formulaYmlPath = getLocalFormulaYmlPath(cwd);

  if (!(await exists(formulaYmlPath))) {
    return { direct, transitive };
  }

  let config: FormulaYml;
  try {
    config = await parseFormulaYml(formulaYmlPath);
  } catch (error) {
    logger.warn(`Failed to parse main formula.yml while computing dependency coverage: ${error}`);
    return { direct, transitive };
  }

  const topLevel = extractFormulasFromConfig(config);
  if (topLevel.length === 0) {
    return { direct, transitive };
  }

  const globalConstraints = await gatherGlobalVersionConstraints(cwd);
  const rootConstraints = await gatherRootVersionConstraints(cwd);

  for (const dep of topLevel) {
    const normalizedName = normalizeFormulaName(dep.name);
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

      for (const resolved of result.resolvedFormulas) {
        if (resolved.isRoot) {
          continue;
        }
        transitive.add(normalizeFormulaName(resolved.name));
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

export async function isFormulaTransitivelyCovered(cwd: string, formulaName: string): Promise<boolean> {
  const { transitive } = await getDependencyCoverage(cwd);
  return transitive.has(normalizeFormulaName(formulaName));
}

export async function isFormulaCovered(
  cwd: string,
  formulaName: string,
  options?: { includeDirect?: boolean }
): Promise<boolean> {
  const coverage = await getDependencyCoverage(cwd);
  const normalized = normalizeFormulaName(formulaName);

  if (options?.includeDirect !== false && coverage.direct.has(normalized)) {
    return true;
  }

  return coverage.transitive.has(normalized);
}

