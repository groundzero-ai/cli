import * as yaml from 'js-yaml';
import * as semver from 'semver';
import { safePrompts } from '../utils/prompts.js';
import { FormulaYml, Formula } from '../types/index.js';
import { formulaManager } from './formula.js';
import { getInstalledFormulaVersion, scanGroundzeroFormulas } from './groundzero.js';
import { logger } from '../utils/logger.js';
import { FormulaNotFoundError, FormulaVersionNotFoundError, VersionConflictError } from '../utils/errors.js';
import { isExactVersion } from '../utils/version-ranges.js';
import { listFormulaVersions } from './directory.js';

/**
 * Resolved formula interface for dependency resolution
 */
export interface ResolvedFormula {
  name: string;
  version: string;
  formula: Formula;
  isRoot: boolean;
  conflictResolution?: 'kept' | 'overwritten' | 'skipped';
  requiredVersion?: string; // The version required by the parent formula
  requiredRange?: string; // The version range required by the parent formula
}

/**
 * Dependency node interface for dependency tree operations
 */
export interface DependencyNode {
  name: string;
  version: string;
  dependencies: Set<string>;
  dependents: Set<string>;
  isProtected: boolean; // Listed in cwd formula.yml
}

/**
 * Prompt user for overwrite confirmation
 */
export async function promptOverwrite(formulaName: string, existingVersion: string, newVersion: string): Promise<boolean> {
  const response = await safePrompts({
    type: 'confirm',
    name: 'shouldOverwrite',
    message: `Formula '${formulaName}' conflict: existing v${existingVersion} vs required v${newVersion}. Overwrite with v${newVersion}?`,
    initial: true
  });
  
  return response.shouldOverwrite || false;
}

/**
 * Recursively resolve formula dependencies for installation
 */
export async function resolveDependencies(
  formulaName: string,
  targetDir: string,
  isRoot: boolean = true,
  visitedStack: Set<string> = new Set(),
  resolvedFormulas: Map<string, ResolvedFormula> = new Map(),
  version?: string,
  requiredVersions: Map<string, string[]> = new Map(),
  globalConstraints?: Map<string, string[]>
): Promise<ResolvedFormula[]> {
  // 1. Cycle detection
  if (visitedStack.has(formulaName)) {
    const cycle = Array.from(visitedStack);
    const cycleStart = cycle.indexOf(formulaName);
    const actualCycle = cycle.slice(cycleStart).concat([formulaName]);
    throw new Error(`❌ Circular dependency detected:\n   ${actualCycle.join(' → ')}\n\n💡 Review your formula dependencies to break the cycle.`);
  }
  
  // 2. Resolve version range(s) to specific version if needed
  let resolvedVersion: string | undefined;
  let versionRange: string | undefined;
  const allRanges: string[] = [];

  if (version) {
    allRanges.push(version);
  }

  const globalRanges = globalConstraints?.get(formulaName);
  if (globalRanges) {
    allRanges.push(...globalRanges);
  }

  const priorRanges = requiredVersions.get(formulaName) || [];
  if (priorRanges.length > 0) {
    allRanges.push(...priorRanges);
  }

  if (allRanges.length === 0) {
    // No constraints provided - resolvedVersion stays undefined so latest is used
  } else if (allRanges.length === 1 && isExactVersion(allRanges[0])) {
    resolvedVersion = allRanges[0];
    versionRange = allRanges[0];
  } else {
    // Intersect ranges by filtering available versions
    const availableVersions = await listFormulaVersions(formulaName);
    if (availableVersions.length === 0) {
      throw new FormulaNotFoundError(formulaName);
    }

    const satisfying = availableVersions.filter(versionCandidate => {
      return allRanges.every(range => {
        try {
          // Always include prerelease versions when evaluating satisfaction
          return semver.satisfies(versionCandidate, range, { includePrerelease: true });
        } catch (error) {
          logger.debug(`Failed to evaluate semver for ${formulaName}@${versionCandidate} against range '${range}': ${error}`);
          return false;
        }
      });
    }).sort((a, b) => semver.rcompare(a, b));

    if (satisfying.length === 0) {
      throw new VersionConflictError(formulaName, {
        ranges: allRanges,
        availableVersions
      });
    }

    resolvedVersion = satisfying[0];
    versionRange = allRanges.join(' & ');
    logger.debug(`Resolved constraints [${allRanges.join(', ')}] to '${resolvedVersion}' for formula '${formulaName}'`);
  }

  // 3. Attempt to repair dependency from local registry
  let formula: Formula;
  try {
    // Load formula with resolved version
    logger.debug(`Attempting to load formula '${formulaName}' from local registry`, { 
      version: resolvedVersion, 
      originalRange: versionRange 
    });
    formula = await formulaManager.loadFormula(formulaName, resolvedVersion);
    logger.debug(`Successfully loaded formula '${formulaName}' from local registry`, { version: formula.metadata.version });
  } catch (error) {
    if (error instanceof FormulaNotFoundError) {
      // Auto-repair attempt: Check if formula exists in registry but needs to be loaded
      logger.debug(`Formula '${formulaName}' not found in local registry, attempting repair`);
      
      try {
        // Check if formula exists in registry metadata (but files might be missing)
        const { registryManager } = await import('./registry.js');
        const hasFormula = await registryManager.hasFormula(formulaName);
        logger.debug(`Registry check for '${formulaName}': hasFormula=${hasFormula}, requiredVersion=${version}`);
        
        if (hasFormula) {
          // Check if the specific version exists
          if (version) {
            const hasSpecificVersion = await registryManager.hasFormulaVersion(formulaName, version);
            if (!hasSpecificVersion) {
              // Formula exists but not in the required version - this is not a repairable error
              const dependencyChain = Array.from(visitedStack);
              let errorMessage = `Formula '${formulaName}' exists in registry but version '${version}' is not available\n\n`;
              
              if (dependencyChain.length > 0) {
                errorMessage += `📋 Dependency chain:\n`;
                for (let i = 0; i < dependencyChain.length; i++) {
                  const indent = '  '.repeat(i);
                  errorMessage += `${indent}└─ ${dependencyChain[i]}\n`;
                }
                errorMessage += `${'  '.repeat(dependencyChain.length)}└─ ${formulaName}@${version} ❌ (version not available)\n\n`;
              }
              
              errorMessage += `💡 To resolve this issue:\n`;
              errorMessage += `   • Install the available version: g0 install ${formulaName}@latest\n`;
              errorMessage += `   • Update the dependency to use an available version\n`;
              errorMessage += `   • Create the required version locally: g0 init && g0 save\n`;
              
              throw new FormulaVersionNotFoundError(errorMessage);
            }
          }
          
          logger.info(`Found formula '${formulaName}' in registry metadata, attempting repair`);
          // Try to reload the formula metadata
          const metadata = await registryManager.getFormulaMetadata(formulaName, version);
          // Attempt to load again with the same version - this might succeed if it was a temporary issue
          formula = await formulaManager.loadFormula(formulaName, version);
          logger.info(`Successfully repaired and loaded formula '${formulaName}'`);
        } else {
          throw error; // Formula truly doesn't exist in registry
        }
      } catch (repairError) {
        // If this is a version-specific error we created, re-throw it directly
        if (repairError instanceof FormulaVersionNotFoundError) {
          throw repairError;
        }
        
        // Repair failed - create helpful error message with dependency chain context
        const dependencyChain = Array.from(visitedStack);
        let errorMessage = `❌ Auto-repair failed: Formula '${formulaName}' not available in local registry\n\n`;
        
        if (dependencyChain.length > 0) {
          errorMessage += `📋 Dependency chain:\n`;
          for (let i = 0; i < dependencyChain.length; i++) {
            const indent = '  '.repeat(i);
            errorMessage += `${indent}└─ ${dependencyChain[i]}\n`;
          }
          errorMessage += `${'  '.repeat(dependencyChain.length)}└─ ${formulaName} ❌ (not available)\n\n`;
        }
        
        errorMessage += `🔧 Auto-repair attempted but failed:\n`;
        errorMessage += `   • Checked local registry: ${repairError instanceof FormulaNotFoundError ? 'not found' : 'access failed'}\n`;
        errorMessage += `   • Formula is not available in the local registry\n\n`;
        errorMessage += `💡 To resolve this issue:\n`;
        errorMessage += `   • Create the formula locally: g0 init && g0 save\n`;
        errorMessage += `   • Pull from remote registry: g0 pull ${formulaName}\n`;
        errorMessage += `   • Remove the dependency from the requiring formula\n`;
        
        throw new Error(errorMessage);
      }
    } else {
      // Re-throw other errors
      throw error;
    }
  }
  
  const currentVersion = formula.metadata.version;
  
  // 3. Check for existing resolution
  const existing = resolvedFormulas.get(formulaName);
  if (existing) {
    const comparison = semver.compare(currentVersion, existing.version);
    
    if (comparison > 0) {
      // Current version is newer - prompt to overwrite
      const shouldOverwrite = await promptOverwrite(formulaName, existing.version, currentVersion);
      if (shouldOverwrite) {
        existing.version = currentVersion;
        existing.formula = formula;
        existing.conflictResolution = 'overwritten';
      } else {
        existing.conflictResolution = 'skipped';
      }
    } else {
      // Existing version is same or newer - keep existing
      existing.conflictResolution = 'kept';
    }
    return Array.from(resolvedFormulas.values());
  }
  
  // 3.1. Check for already installed version in groundzero
  const installedVersion = await getInstalledFormulaVersion(formulaName, targetDir);
  if (installedVersion) {
    const comparison = semver.compare(currentVersion, installedVersion);
    
    if (comparison > 0) {
      // New version is greater than installed - allow installation but will prompt later
      logger.debug(`Formula '${formulaName}' will be upgraded from v${installedVersion} to v${currentVersion}`);
    } else if (comparison === 0) {
      // Same version - skip installation
      logger.debug(`Formula '${formulaName}' v${currentVersion} already installed, skipping`);
      resolvedFormulas.set(formulaName, {
        name: formulaName,
        version: installedVersion,
        formula,
        isRoot,
        conflictResolution: 'kept'
      });
      return Array.from(resolvedFormulas.values());
    } else {
      // New version is older than installed - skip installation
      logger.debug(`Formula '${formulaName}' has newer version installed (v${installedVersion} > v${currentVersion}), skipping`);
      resolvedFormulas.set(formulaName, {
        name: formulaName,
        version: installedVersion,
        formula,
        isRoot,
        conflictResolution: 'kept'
      });
      return Array.from(resolvedFormulas.values());
    }
  }
  
  // 4. Track required version if specified
  if (version) {
    if (!requiredVersions.has(formulaName)) {
      requiredVersions.set(formulaName, []);
    }
    requiredVersions.get(formulaName)!.push(version);
  }

  // 5. Add to resolved map
  resolvedFormulas.set(formulaName, {
    name: formulaName,
    version: currentVersion,
    formula,
    isRoot,
    requiredVersion: resolvedVersion, // Track the resolved version
    requiredRange: versionRange // Track the original range
  });
  
  // 5. Parse dependencies from formula's .formula.yml
  const formulaYmlFile = formula.files.find(f => f.path === 'formula.yml');
  if (formulaYmlFile) {
    const config = yaml.load(formulaYmlFile.content) as FormulaYml;
    
    // 6. Recursively resolve dependencies
    visitedStack.add(formulaName);
    
    // Only process 'formulas' array (NOT 'dev-formulas' for transitive dependencies)
    const dependencies = config.formulas || [];
    
    for (const dep of dependencies) {
      // Pass the required version from the dependency specification
      await resolveDependencies(dep.name, targetDir, false, visitedStack, resolvedFormulas, dep.version, requiredVersions, globalConstraints);
    }
    
    // For root formula, also process dev-formulas
    if (isRoot) {
      const devDependencies = config['dev-formulas'] || [];
      for (const dep of devDependencies) {
        // Pass the required version from the dev dependency specification
        await resolveDependencies(dep.name, targetDir, false, visitedStack, resolvedFormulas, dep.version, requiredVersions, globalConstraints);
      }
    }
    
    visitedStack.delete(formulaName);
  }
  
  // Attach the requiredVersions map to each resolved formula for later use
  const resolvedArray = Array.from(resolvedFormulas.values());
  for (const resolved of resolvedArray) {
    (resolved as any).requiredVersions = requiredVersions;
  }
  
  return resolvedArray;
}

/**
 * Display dependency tree to user
 */
export function displayDependencyTree(resolvedFormulas: ResolvedFormula[], silent: boolean = false): void {
  if (silent) return;
  const root = resolvedFormulas.find(f => f.isRoot);
  if (!root) return;
  
  console.log(`\n📦 Installing ${root.name}@${root.version} with dependencies:\n`);
  
  // Show root
  console.log(`${root.name}@${root.version} (root)`);
  
  // Show transitive dependencies
  const transitive = resolvedFormulas.filter(f => !f.isRoot);
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
  
  console.log(`\n🔍 Total: ${resolvedFormulas.length} formulas\n`);
}

/**
 * Build dependency tree for all formulas in groundzero (used by uninstall)
 */
export async function buildDependencyTree(groundzeroPath: string, protectedFormulas: Set<string>): Promise<Map<string, DependencyNode>> {
  const dependencyTree = new Map<string, DependencyNode>();
  
  // Use the shared scanGroundzeroFormulas function
  const formulas = await scanGroundzeroFormulas(groundzeroPath);
  
  // First pass: collect all formulas and their dependencies
  for (const [formulaName, formula] of formulas) {
    const dependencies = new Set<string>();
    
    // Collect dependencies from both formulas and dev-formulas
    const allDeps = [
      ...(formula.formulas || []),
      ...(formula['dev-formulas'] || [])
    ];
    
    for (const dep of allDeps) {
      dependencies.add(dep.name);
    }
    
    dependencyTree.set(formulaName, {
      name: formulaName,
      version: formula.version,
      dependencies,
      dependents: new Set(),
      isProtected: protectedFormulas.has(formulaName)
    });
  }
  
  // Second pass: build dependents relationships
  for (const [formulaName, node] of dependencyTree) {
    for (const depName of node.dependencies) {
      const depNode = dependencyTree.get(depName);
      if (depNode) {
        depNode.dependents.add(formulaName);
      }
    }
  }
  
  return dependencyTree;
}

/**
 * Get all dependencies of a formula recursively
 */
export async function getAllDependencies(formulaName: string, dependencyTree: Map<string, DependencyNode>, visited: Set<string> = new Set()): Promise<Set<string>> {
  const allDeps = new Set<string>();
  
  if (visited.has(formulaName)) {
    return allDeps; // Prevent infinite recursion
  }
  
  visited.add(formulaName);
  const node = dependencyTree.get(formulaName);
  
  if (node) {
    for (const dep of node.dependencies) {
      allDeps.add(dep);
      const subDeps = await getAllDependencies(dep, dependencyTree, visited);
      for (const subDep of subDeps) {
        allDeps.add(subDep);
      }
    }
  }
  
  visited.delete(formulaName);
  return allDeps;
}

/**
 * Find dangling dependencies that can be safely removed (used by uninstall)
 */
export async function findDanglingDependencies(
  targetFormula: string,
  dependencyTree: Map<string, DependencyNode>
): Promise<Set<string>> {
  const danglingDeps = new Set<string>();
  
  // Get all dependencies of the target formula
  const allDependencies = await getAllDependencies(targetFormula, dependencyTree);
  
  // Check each dependency to see if it's dangling
  for (const depName of allDependencies) {
    const depNode = dependencyTree.get(depName);
    if (!depNode) continue;
    
    // Skip if protected (listed in cwd formula.yml)
    if (depNode.isProtected) {
      logger.debug(`Skipping protected formula: ${depName}`);
      continue;
    }
    
    // Check if this dependency has any dependents outside the dependency tree being removed
    let hasExternalDependents = false;
    for (const dependent of depNode.dependents) {
      // If the dependent is not the target formula and not in the dependency tree, it's external
      if (dependent !== targetFormula && !allDependencies.has(dependent)) {
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
