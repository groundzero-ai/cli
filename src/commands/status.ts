import { Command } from 'commander';
import { join } from 'path';
import * as semver from 'semver';
import { CommandResult, FormulaYml, FormulaDependency } from '../types/index.js';
import { parseFormulaYml } from '../utils/formula-yml.js';
import { ensureRegistryDirectories } from '../core/directory.js';
import { scanGroundzeroFormulas, GroundzeroFormula } from '../core/groundzero.js';
import { exists, readTextFile } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling } from '../utils/errors.js';

/**
 * Enhanced formula status interface
 */
interface FormulaStatusInfo {
  name: string;
  installedVersion: string;
  availableVersion?: string;
  status: 'installed' | 'outdated' | 'missing' | 'dependency-mismatch';
  type: 'formula' | 'dev-formula' | 'dependency';
  dependencies?: FormulaStatusInfo[];
  path?: string;
  issues?: string[];
}




/**
 * Analyze status of a single formula
 */
async function analyzeFormulaStatus(
  requiredFormula: FormulaDependency,
  availableFormula: GroundzeroFormula | null,
  type: 'formula' | 'dev-formula' | 'dependency'
): Promise<FormulaStatusInfo> {
  
  const status: FormulaStatusInfo = {
    name: requiredFormula.name,
    installedVersion: requiredFormula.version,
    type,
    status: 'missing'
  };

  // Case 1: Formula not found in groundzero
  if (!availableFormula) {
    return {
      ...status,
      status: 'missing',
      availableVersion: undefined,
      issues: [`Formula '${requiredFormula.name}' not found in groundzero directory`]
    };
  }

  // Case 2: Formula exists - compare versions  
  status.availableVersion = availableFormula.version;
  status.path = availableFormula.path;

  // Version comparison logic using semver
  if (semver.eq(requiredFormula.version, availableFormula.version)) {
    status.status = 'installed';
  } else {
    status.status = 'outdated';
    status.issues = [`Version mismatch: required ${requiredFormula.version}, available ${availableFormula.version}`];
  }

  return status;
}

/**
 * Build dependency tree for a formula
 */
async function buildFormulaDependencies(
  formulaName: string,
  availableFormulas: Map<string, GroundzeroFormula>,
  visited: Set<string> = new Set()
): Promise<FormulaStatusInfo[]> {
  const dependencies: FormulaStatusInfo[] = [];
  
  // Prevent circular dependencies
  if (visited.has(formulaName)) {
    return dependencies;
  }
  
  visited.add(formulaName);
  
  const formula = availableFormulas.get(formulaName);
  if (!formula || !formula.formulas) {
    visited.delete(formulaName);
    return dependencies;
  }
  
  for (const dep of formula.formulas) {
    const availableDep = availableFormulas.get(dep.name) || null;
    const depStatus = await analyzeFormulaStatus(dep, availableDep, 'dependency');
    
    // Recursively get dependencies of this dependency
    if (depStatus.status === 'installed') {
      depStatus.dependencies = await buildFormulaDependencies(dep.name, availableFormulas, new Set(visited));
    }
    
    dependencies.push(depStatus);
  }
  
  visited.delete(formulaName);
  return dependencies;
}

/**
 * Perform complete status analysis
 */
async function performStatusAnalysis(targetDir: string): Promise<{
  projectInfo: { name: string; version: string };
  formulas: FormulaStatusInfo[];
}> {
  // 1. Read CWD formula.yml
  const cwdFormulaPath = join(targetDir, 'formula.yml');
  let cwdConfig: FormulaYml;
  
  if (!(await exists(cwdFormulaPath))) {
    throw new Error(`No formula.yml found in ${targetDir}. This directory doesn't appear to be a formula project.`);
  }
  
  try {
    cwdConfig = await parseFormulaYml(cwdFormulaPath);
  } catch (error) {
    throw new Error(`Failed to parse formula.yml: ${error}`);
  }
  
  // 2. Scan groundzero formulas
  const groundzeroPath = join(targetDir, 'groundzero');
  const availableFormulas = await scanGroundzeroFormulas(groundzeroPath);
  
  // 3. Analyze each required formula
  const results: FormulaStatusInfo[] = [];
  
  // Analyze production formulas
  for (const formula of cwdConfig.formulas || []) {
    const available = availableFormulas.get(formula.name) || null;
    const status = await analyzeFormulaStatus(formula, available, 'formula');
    
    // Build dependency tree for installed formulas
    if (status.status === 'installed') {
      status.dependencies = await buildFormulaDependencies(formula.name, availableFormulas);
    }
    
    results.push(status);
  }
  
  // Analyze dev formulas  
  for (const formula of cwdConfig['dev-formulas'] || []) {
    const available = availableFormulas.get(formula.name) || null;
    const status = await analyzeFormulaStatus(formula, available, 'dev-formula');
    
    // Build dependency tree for installed formulas
    if (status.status === 'installed') {
      status.dependencies = await buildFormulaDependencies(formula.name, availableFormulas);
    }
    
    results.push(status);
  }
  
  return {
    projectInfo: {
      name: cwdConfig.name,
      version: cwdConfig.version
    },
    formulas: results
  };
}

/**
 * Render tree view of formulas
 */
function renderTreeView(
  projectInfo: { name: string; version: string },
  formulas: FormulaStatusInfo[],
  depth?: number
): void {
  console.log(`${projectInfo.name}@${projectInfo.version}`);
  
  if (formulas.length === 0) {
    console.log('└── (no formulas)');
    return;
  }
  
  for (let i = 0; i < formulas.length; i++) {
    const isLast = i === formulas.length - 1;
    renderFormulaTree(formulas[i], '', isLast, depth, 1);
  }
}

/**
 * Render individual formula in tree format
 */
function renderFormulaTree(
  formula: FormulaStatusInfo,
  prefix: string,
  isLast: boolean,
  maxDepth?: number,
  currentDepth: number = 1
): void {
  const connector = isLast ? '└── ' : '├── ';
  const typePrefix = formula.type === 'dev-formula' ? '[dev] ' : '';
  
  let statusSuffix = '';
  if (formula.status === 'outdated') {
    statusSuffix = ` (outdated: ${formula.availableVersion} available)`;
  } else if (formula.status === 'missing') {
    statusSuffix = ' (missing)';
  } else if (formula.status === 'dependency-mismatch') {
    statusSuffix = ' (dependency mismatch)';
  }
  
  console.log(`${prefix}${connector}${typePrefix}${formula.name}@${formula.installedVersion}${statusSuffix}`);
  
  // Show dependencies if within depth limit
  if (formula.dependencies && formula.dependencies.length > 0) {
    if (!maxDepth || currentDepth < maxDepth) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      
      for (let j = 0; j < formula.dependencies.length; j++) {
        const isLastChild = j === formula.dependencies.length - 1;
        renderFormulaTree(formula.dependencies[j], childPrefix, isLastChild, maxDepth, currentDepth + 1);
      }
    } else {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      console.log(`${childPrefix}└── (${formula.dependencies.length} dependencies - use --depth to see more)`);
    }
  }
}

/**
 * Render flat table view of formulas
 */
function renderFlatView(formulas: FormulaStatusInfo[]): void {
  if (formulas.length === 0) {
    console.log('No formulas found.');
    return;
  }
  
  // Collect all formulas including dependencies
  const allFormulas: FormulaStatusInfo[] = [];
  
  function collectFormulas(formulaList: FormulaStatusInfo[]) {
    for (const formula of formulaList) {
      allFormulas.push(formula);
      if (formula.dependencies) {
        collectFormulas(formula.dependencies);
      }
    }
  }
  
  collectFormulas(formulas);
  
  // Table header
  console.log('FORMULA'.padEnd(20) + 'INSTALLED'.padEnd(12) + 'STATUS'.padEnd(15) + 'TYPE'.padEnd(15) + 'AVAILABLE');
  console.log('-------'.padEnd(20) + '---------'.padEnd(12) + '------'.padEnd(15) + '----'.padEnd(15) + '---------');
  
  // Display each formula
  for (const formula of allFormulas) {
    const name = formula.name.padEnd(20);
    const installed = formula.installedVersion.padEnd(12);
    const status = formula.status.padEnd(15);
    const type = formula.type.padEnd(15);
    const available = (formula.availableVersion || '-').padEnd(9);
    
    console.log(`${name}${installed}${status}${type}${available}`);
  }
  
  console.log('');
  console.log(`Total: ${allFormulas.length} formulas`);
}

/**
 * Status command implementation - shows formula status using formula.yml system
 */
async function statusCommand(targetDir: string, options: { flat?: boolean; depth?: number }): Promise<CommandResult> {
  logger.info(`Checking formula status for directory: ${targetDir}`);
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  try {
    const { projectInfo, formulas } = await performStatusAnalysis(targetDir);
    
    // Display results
    console.log(`📁 Formula status for: ${targetDir}`);
    console.log('');
    
    if (options.flat) {
      renderFlatView(formulas);
    } else {
      renderTreeView(projectInfo, formulas, options.depth);
    }
    
    // Show summary and issues
    const totalFormulas = formulas.length;
    const installedCount = formulas.filter(f => f.status === 'installed').length;
    const missingCount = formulas.filter(f => f.status === 'missing').length;
    const outdatedCount = formulas.filter(f => f.status === 'outdated').length;
    
    console.log('');
    console.log(`Summary: ${installedCount}/${totalFormulas} installed`);
    
    if (missingCount > 0) {
      console.log(`⚠️  ${missingCount} formulas missing from groundzero`);
    }
    
    if (outdatedCount > 0) {
      console.log(`⚠️  ${outdatedCount} formulas have version mismatches`);
    }
    
    if (totalFormulas === 0) {
      console.log('');
      console.log('Tips:');
      console.log('• Add formulas to formula.yml and run "g0 install" to install them');
      console.log('• Use "g0 list" to see available formulas in the registry');
    }
  
  return {
    success: true,
      data: formulas
  };
  } catch (error) {
    logger.error('Status command failed', { error, targetDir });
    throw error;
  }
}

/**
 * Setup the status command
 */
export function setupStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show formula status in a directory')
    .argument('[target-dir]', 'target directory (defaults to current directory)', '.')
    .option('--flat', 'show flat table view instead of tree view')
    .option('--depth <number>', 'limit tree depth (default: unlimited)', parseInt)
    .action(withErrorHandling(async (targetDir: string, options: { flat?: boolean; depth?: number }) => {
      await statusCommand(targetDir, options);
    }));
}
