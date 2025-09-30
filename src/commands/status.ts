import { Command } from 'commander';
import { join } from 'path';
import * as semver from 'semver';
import { CommandResult, FormulaYml, FormulaDependency } from '../types/index.js';
import { parseFormulaYml } from '../utils/formula-yml.js';
import { ensureRegistryDirectories, listFormulaVersions } from '../core/directory.js';
import { scanGroundzeroFormulas, GroundzeroFormula, gatherGlobalVersionConstraints } from '../core/groundzero.js';
import { resolveDependencies } from '../core/dependency-resolver.js';
import { registryManager } from '../core/registry.js';
import { exists, listDirectories } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, ValidationError } from '../utils/errors.js';
import { 
  getLocalFormulaYmlPath,
  getLocalFormulasDir,
  getLocalGroundZeroDir,
  getAIDir
} from '../utils/paths.js';
import { 
  satisfiesVersion, 
  isExactVersion, 
  describeVersionRange
} from '../utils/version-ranges.js';
import {
  PLATFORM_DIRS,
  PLATFORM_NAMES,
  FILE_PATTERNS,
  UNIVERSAL_SUBDIRS,
  DEPENDENCY_ARRAYS
} from '../constants/index.js';

/**
 * Formula status types
 */
type FormulaStatus = 'installed' | 'outdated' | 'missing' | 'dependency-mismatch' | 'registry-unavailable' | 'structure-invalid' | 'platform-mismatch' | 'update-available';
type FormulaType = 'formula' | 'dev-formula' | 'dependency';

/**
 * Enhanced formula status interface
 */
interface FormulaStatusInfo {
  name: string;
  installedVersion: string;
  availableVersion?: string;
  registryVersion?: string;
  status: FormulaStatus;
  type: FormulaType;
  dependencies?: FormulaStatusInfo[];
  path?: string;
  issues?: string[];
  conflictResolution?: string;
}

/**
 * Platform status information
 */
interface PlatformStatus {
  name: string;
  detected: boolean;
  configured: boolean;
  directoryExists: boolean;
  templatesPresent: boolean;
}

/**
 * Project status information
 */
interface ProjectStatus {
  name: string;
  version: string;
  groundzeroExists: boolean;
  formulaYmlExists: boolean;
  formulasDirectoryExists: boolean;
  platforms: PlatformStatus[];
  aiDirectoryExists: boolean;
}

/**
 * Status analysis options
 */
interface StatusOptions {
  registry?: boolean;
  platforms?: boolean;
}

/**
 * Command options
 */
interface CommandOptions {
  flat?: boolean;
  depth?: number;
  registry?: boolean;
  platforms?: boolean;
  repair?: boolean;
}




/**
 * Scan local formula metadata from .groundzero/formulas directory
 */
async function scanLocalFormulaMetadata(cwd: string): Promise<Map<string, FormulaYml>> {
  const formulasDir = getLocalFormulasDir(cwd);
  const localFormulas = new Map<string, FormulaYml>();
  
  if (!(await exists(formulasDir))) {
    return localFormulas;
  }
  
  try {
    const subdirectories = await listDirectories(formulasDir);
    
    // Process directories in parallel for better performance
    const parsePromises = subdirectories.map(async (subdir) => {
      const formulaDir = join(formulasDir, subdir);
      const formulaYmlPath = join(formulaDir, FILE_PATTERNS.FORMULA_YML);
      
      if (await exists(formulaYmlPath)) {
        try {
          const formulaConfig = await parseFormulaYml(formulaYmlPath);
          return { name: formulaConfig.name, config: formulaConfig };
        } catch (error) {
          logger.warn(`Failed to parse local formula metadata: ${formulaYmlPath}`, { error });
        }
      }
      return null;
    });
    
    const results = await Promise.all(parsePromises);
    
    for (const result of results) {
      if (result) {
        localFormulas.set(result.name, result.config);
      }
    }
  } catch (error) {
    logger.error('Failed to scan local formula metadata', { error, formulasDir });
  }
  
  return localFormulas;
}

/**
 * Detect platform status and configuration
 */
async function detectPlatformStatus(cwd: string): Promise<PlatformStatus[]> {
  // Define platform configurations
  const platformConfigs = [
    {
      name: PLATFORM_NAMES.CURSOR,
      dir: join(cwd, PLATFORM_DIRS.CURSOR),
      templateFile: join(cwd, PLATFORM_DIRS.CURSOR, UNIVERSAL_SUBDIRS.RULES, FILE_PATTERNS.GROUNDZERO_MDC)
    },
    {
      name: PLATFORM_NAMES.CLAUDECODE,
      dir: join(cwd, PLATFORM_DIRS.CLAUDECODE),
      templateFile: join(cwd, PLATFORM_DIRS.CLAUDECODE, FILE_PATTERNS.GROUNDZERO_MD)
    }
  ];
  
  // Check all platforms in parallel
  const platformChecks = platformConfigs.map(async (config) => {
    const [dirExists, templateExists] = await Promise.all([
      exists(config.dir),
      exists(config.templateFile)
    ]);
    
    return {
      name: config.name,
      detected: dirExists,
      configured: dirExists,
      directoryExists: dirExists,
      templatesPresent: templateExists
    };
  });
  
  return Promise.all(platformChecks);
}

/**
 * Check registry for available versions
 */
async function checkRegistryVersions(formulaName: string): Promise<{ latest?: string; available: string[] }> {
  try {
    const [hasFormula, metadata, available] = await Promise.all([
      registryManager.hasFormula(formulaName),
      registryManager.getFormulaMetadata(formulaName).catch(() => null),
      listFormulaVersions(formulaName).catch(() => [])
    ]);
    
    if (!hasFormula) {
      return { available: [] };
    }
    
    return {
      latest: metadata?.version,
      available: available || []
    };
  } catch (error) {
    logger.debug(`Failed to check registry for formula ${formulaName}`, { error });
    return { available: [] };
  }
}

/**
 * Analyze status of a single formula with enhanced checks
 */
async function analyzeFormulaStatus(
  requiredFormula: FormulaDependency,
  availableFormula: GroundzeroFormula | null,
  localMetadata: FormulaYml | null,
  type: FormulaType,
  registryCheck: boolean = false
): Promise<FormulaStatusInfo> {
  const status: FormulaStatusInfo = {
    name: requiredFormula.name,
    installedVersion: requiredFormula.version,
    type,
    status: 'missing'
  };
  
  // Check registry if requested
  if (registryCheck) {
    const registryInfo = await checkRegistryVersions(requiredFormula.name);
    status.registryVersion = registryInfo.latest;
    
    if (registryInfo.available.length === 0) {
      status.status = 'registry-unavailable';
      status.issues = [`Formula '${requiredFormula.name}' not found in registry`];
      return status;
    }
  }

  // Case 1: Formula not found in ai directory
  if (!availableFormula) {
    if (localMetadata) {
      status.status = 'structure-invalid';
      status.issues = [`Formula '${requiredFormula.name}' has local metadata but no files in ai directory`];
    } else {
      status.status = 'missing';
      status.issues = [`Formula '${requiredFormula.name}' not found in ai directory`];
    }
    
    // Check for registry updates if available
    if (registryCheck && status.registryVersion && status.status === 'missing') {
      status.status = 'update-available';
      status.issues?.push(`Version ${status.registryVersion} available in registry`);
    }
    
    return status;
  }

  // Case 2: Formula exists - compare versions  
  status.availableVersion = availableFormula.version;
  status.path = availableFormula.path;

  const requiredVersion = requiredFormula.version;
  const installedVersion = availableFormula.version;
  
  // Check version compatibility
  try {
    if (satisfiesVersion(installedVersion, requiredVersion)) {
      status.status = 'installed';
      
      // Check for registry updates if requested
      if (registryCheck && status.registryVersion && semver.gt(status.registryVersion, installedVersion)) {
        status.status = 'update-available';
        status.issues = [`Newer version ${status.registryVersion} available in registry`];
      }
    } else {
      // Determine version mismatch type
      if (isExactVersion(requiredVersion)) {
        status.status = semver.gt(installedVersion, requiredVersion) ? 'outdated' : 'dependency-mismatch';
        const comparison = semver.gt(installedVersion, requiredVersion) ? 'newer than' : 'older than';
        status.issues = [`Installed version ${installedVersion} is ${comparison} required ${requiredVersion}`];
      } else {
        status.status = 'dependency-mismatch';
        status.issues = [`Installed version ${installedVersion} does not satisfy range ${requiredVersion} (${describeVersionRange(requiredVersion)})`];
      }
    }
  } catch (error) {
    status.status = 'dependency-mismatch';
    status.issues = [`Version analysis failed: ${error}`];
  }
  
  // Validate local metadata consistency
  if (localMetadata && localMetadata.version !== installedVersion) {
    status.issues = status.issues || [];
    status.issues.push(`Local metadata version ${localMetadata.version} differs from ai version ${installedVersion}`);
    if (status.status === 'installed') {
      status.status = 'structure-invalid';
    }
  }

  return status;
}

/**
 * Build dependency tree using install's dependency resolver
 */
async function buildFormulaDependencyTree(
  formulaName: string,
  cwd: string,
  availableFormulas: Map<string, GroundzeroFormula>,
  localMetadata: Map<string, FormulaYml>,
  version?: string,
  registryCheck: boolean = false
): Promise<FormulaStatusInfo[]> {
  try {
    // Use the install command's dependency resolver to get the complete tree
    const constraints = await gatherGlobalVersionConstraints(cwd);
    const resolvedFormulas = await resolveDependencies(
      formulaName,
      cwd,
      true,
      new Set(),
      new Map(),
      version,
      new Map(),
      constraints
    );
    
    // Convert resolved formulas to status info in parallel
    const dependencyPromises = resolvedFormulas
      .filter(resolved => !resolved.isRoot) // Skip the root formula
      .map(async (resolved) => {
        const availableFormula = availableFormulas.get(resolved.name) || null;
        const localMeta = localMetadata.get(resolved.name) || null;
        
        const dependency: FormulaDependency = {
          name: resolved.name,
          version: resolved.requiredRange || resolved.version
        };
        
        const depStatus = await analyzeFormulaStatus(
          dependency,
          availableFormula,
          localMeta,
          'dependency',
          registryCheck
        );
        
        if (resolved.conflictResolution) {
          depStatus.conflictResolution = resolved.conflictResolution;
        }
        
        return depStatus;
      });
    
    return Promise.all(dependencyPromises);
  } catch (error) {
    logger.warn(`Failed to resolve dependencies for ${formulaName}`, { error });
    
    // Fallback to basic dependency scanning
    const formula = availableFormulas.get(formulaName);
    if (!formula?.formulas) {
      return [];
    }
    
    const fallbackPromises = formula.formulas.map(async (dep) => {
      const availableDep = availableFormulas.get(dep.name) || null;
      const localMeta = localMetadata.get(dep.name) || null;
      return analyzeFormulaStatus(dep, availableDep, localMeta, 'dependency', registryCheck);
    });
    
    return Promise.all(fallbackPromises);
  }
}

/**
 * Perform complete status analysis with enhanced checks
 */
async function performStatusAnalysis(
  cwd: string,
  options: StatusOptions = {}
): Promise<{
  projectInfo: ProjectStatus;
  formulas: FormulaStatusInfo[];
}> {
  // 1. Check basic project structure in parallel
  const [groundzeroDir, formulaYmlPath, formulasDir, aiDir] = [
    getLocalGroundZeroDir(cwd),
    getLocalFormulaYmlPath(cwd),
    getLocalFormulasDir(cwd),
    getAIDir(cwd)
  ];
  
  const [groundzeroExists, formulaYmlExists, formulasDirExists, aiDirExists] = await Promise.all([
    exists(groundzeroDir),
    exists(formulaYmlPath),
    exists(formulasDir),
    exists(aiDir)
  ]);
  
  if (!groundzeroExists || !formulaYmlExists) {
    throw new ValidationError(
      `No .groundzero/formula.yml found in ${cwd}. This directory doesn't appear to be a formula project.\n\n` +
      `💡 To initialize this as a formula project:\n` +
      `   • Run 'g0 init' to create a new formula project\n` +
      `   • Run 'g0 install' to install existing formulas`
    );
  }
  
  // 2. Parse main formula.yml and detect platforms in parallel
  const [cwdConfig, platformStatuses] = await Promise.all([
    parseFormulaYml(formulaYmlPath).catch(error => {
      throw new ValidationError(`Failed to parse formula.yml: ${error}`);
    }),
    options.platforms ? detectPlatformStatus(cwd) : Promise.resolve([])
  ]);
  
  // 3. Scan various formula sources in parallel
  const [availableFormulas, localMetadata] = await Promise.all([
    scanGroundzeroFormulas(aiDir),
    scanLocalFormulaMetadata(cwd)
  ]);
  
  // 4. Analyze all formulas in parallel
  const allFormulas = [
    ...(cwdConfig.formulas || []).map(f => ({ ...f, type: 'formula' as FormulaType })),
    ...(cwdConfig[DEPENDENCY_ARRAYS.DEV_FORMULAS] || []).map(f => ({ ...f, type: 'dev-formula' as FormulaType }))
  ];
  
  const analysisPromises = allFormulas.map(async (formula) => {
    const available = availableFormulas.get(formula.name) || null;
    const localMeta = localMetadata.get(formula.name) || null;
    const status = await analyzeFormulaStatus(formula, available, localMeta, formula.type, options.registry);
    
    // Build dependency tree if installed
    if (status.status === 'installed') {
      try {
        status.dependencies = await buildFormulaDependencyTree(
          formula.name,
          cwd,
          availableFormulas,
          localMetadata,
          formula.version,
          options.registry
        );
      } catch (error) {
        logger.warn(`Failed to build dependency tree for ${formula.name}`, { error });
        status.issues = status.issues || [];
        status.issues.push(`Dependency analysis failed: ${error}`);
      }
    }
    
    return status;
  });
  
  const results = await Promise.all(analysisPromises);
  
  // 5. Build project status
  const projectInfo: ProjectStatus = {
    name: cwdConfig.name,
    version: cwdConfig.version,
    groundzeroExists,
    formulaYmlExists,
    formulasDirectoryExists: formulasDirExists,
    aiDirectoryExists: aiDirExists,
    platforms: platformStatuses
  };
  
  return {
    projectInfo,
    formulas: results
  };
}

/**
 * Render enhanced tree view of formulas with status
 */
function renderTreeView(
  projectInfo: ProjectStatus,
  formulas: FormulaStatusInfo[],
  options: { depth?: number; platforms?: boolean } = {}
): void {
  // Project header with status indicators
  const statusIndicators = [
    !projectInfo.groundzeroExists && '❌ .groundzero missing',
    !projectInfo.formulaYmlExists && '❌ formula.yml missing',
    !projectInfo.aiDirectoryExists && '⚠️ ai directory missing'
  ].filter(Boolean);
  
  const statusSuffix = statusIndicators.length > 0 ? ` (${statusIndicators.join(', ')})` : '';
  console.log(`${projectInfo.name}@${projectInfo.version}${statusSuffix}`);
  
  // Platform information if requested
  if (options.platforms && projectInfo.platforms.length > 0) {
    console.log('\n🖥️ Platforms:');
    for (const platform of projectInfo.platforms) {
      const status = platform.detected ? '✅' : '❌';
      const templates = platform.templatesPresent ? ' (templates ✅)' : ' (templates ❌)';
      console.log(`  ${status} ${platform.name}${platform.detected ? templates : ''}`);
    }
  }
  
  if (formulas.length === 0) {
    console.log('\n└── (no formulas)');
    return;
  }
  
  console.log('');
  formulas.forEach((formula, i) => {
    const isLast = i === formulas.length - 1;
    renderFormulaTree(formula, '', isLast, options.depth, 1);
  });
}

/**
 * Status icon and suffix mapping
 */
const STATUS_ICONS: Record<FormulaStatus, string> = {
  'installed': '✅',
  'missing': '❌',
  'outdated': '⚠️',
  'dependency-mismatch': '❌',
  'update-available': '🔄',
  'registry-unavailable': '⚠️',
  'structure-invalid': '⚠️',
  'platform-mismatch': '⚠️'
};

/**
 * Get status suffix for display
 */
function getStatusSuffix(formula: FormulaStatusInfo): string {
  switch (formula.status) {
    case 'missing':
      return ' (missing)';
    case 'outdated':
      return ` (outdated: ${formula.availableVersion} available)`;
    case 'dependency-mismatch':
      return ' (version mismatch)';
    case 'update-available':
      return formula.registryVersion ? ` (update: ${formula.registryVersion})` : ' (update available)';
    case 'registry-unavailable':
      return ' (not in registry)';
    case 'structure-invalid':
      return ' (structure issue)';
    case 'platform-mismatch':
      return ' (platform issue)';
    default:
      return '';
  }
}

/**
 * Render individual formula in enhanced tree format
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
  const statusIcon = STATUS_ICONS[formula.status] || '❓';
  const statusSuffix = getStatusSuffix(formula);
  const conflictInfo = formula.conflictResolution ? ` [${formula.conflictResolution}]` : '';
  
  console.log(`${prefix}${connector}${statusIcon} ${typePrefix}${formula.name}@${formula.installedVersion}${statusSuffix}${conflictInfo}`);
  
  // Show issues if any
  if (formula.issues?.length) {
    const issuePrefix = prefix + (isLast ? '    ' : '│   ');
    formula.issues.forEach(issue => {
      console.log(`${issuePrefix}⚠️  ${issue}`);
    });
  }
  
  // Show dependencies if within depth limit
  if (formula.dependencies?.length) {
    if (!maxDepth || currentDepth < maxDepth) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      formula.dependencies.forEach((dep, j) => {
        const isLastChild = j === formula.dependencies!.length - 1;
        renderFormulaTree(dep, childPrefix, isLastChild, maxDepth, currentDepth + 1);
      });
    } else {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      console.log(`${childPrefix}└── (${formula.dependencies.length} dependencies - use --depth to see more)`);
    }
  }
}

/**
 * Collect all formulas including dependencies recursively
 */
function collectAllFormulas(formulas: FormulaStatusInfo[]): FormulaStatusInfo[] {
  const allFormulas: FormulaStatusInfo[] = [];
  
  function collect(formulaList: FormulaStatusInfo[]) {
    for (const formula of formulaList) {
      allFormulas.push(formula);
      if (formula.dependencies) {
        collect(formula.dependencies);
      }
    }
  }
  
  collect(formulas);
  return allFormulas;
}

/**
 * Render enhanced flat table view of formulas
 */
function renderFlatView(formulas: FormulaStatusInfo[], options: { registry?: boolean } = {}): void {
  if (formulas.length === 0) {
    console.log('No formulas found.');
    return;
  }
  
  const allFormulas = collectAllFormulas(formulas);
  
  // Enhanced table header
  const headers = ['FORMULA', 'INSTALLED', 'STATUS', 'TYPE'];
  const widths = [20, 12, 18, 15];
  
  if (options.registry) {
    headers.push('REGISTRY');
    widths.push(12);
  }
  
  headers.push('ISSUES');
  widths.push(30);
  
  // Print header
  console.log(headers.map((h, i) => h.padEnd(widths[i])).join(''));
  console.log(headers.map((_, i) => '-'.repeat(widths[i] - 1).padEnd(widths[i])).join(''));
  
  // Display each formula
  allFormulas.forEach(formula => {
    const values = [
      formula.name.padEnd(widths[0]),
      formula.installedVersion.padEnd(widths[1]),
      formula.status.padEnd(widths[2]),
      formula.type.padEnd(widths[3])
    ];
    
    if (options.registry) {
      values.push((formula.registryVersion || '-').padEnd(widths[4]));
    }
    
    const issues = formula.issues ? formula.issues.slice(0, 2).join('; ') : '-';
    values.push(issues.length > 27 ? issues.substring(0, 24) + '...' : issues);
    
    console.log(values.join(''));
  });
  
  console.log('\nTotal: ${allFormulas.length} formulas');
  
  // Summary by status
  const statusCounts = new Map<string, number>();
  allFormulas.forEach(formula => {
    statusCounts.set(formula.status, (statusCounts.get(formula.status) || 0) + 1);
  });
  
  console.log('\nStatus Summary:');
  statusCounts.forEach((count, status) => {
    console.log(`  ${status}: ${count}`);
  });
}

/**
 * Calculate status counts efficiently
 */
function calculateStatusCounts(formulas: FormulaStatusInfo[]) {
  const counts = {
    installed: 0,
    missing: 0,
    outdated: 0,
    mismatch: 0,
    updateAvailable: 0,
    registryUnavailable: 0,
    structureInvalid: 0
  };
  
  formulas.forEach(formula => {
    switch (formula.status) {
      case 'installed': counts.installed++; break;
      case 'missing': counts.missing++; break;
      case 'outdated': counts.outdated++; break;
      case 'dependency-mismatch': counts.mismatch++; break;
      case 'update-available': counts.updateAvailable++; break;
      case 'registry-unavailable': counts.registryUnavailable++; break;
      case 'structure-invalid': counts.structureInvalid++; break;
    }
  });
  
  return counts;
}

/**
 * Display status summary and recommendations
 */
function displayStatusSummary(formulas: FormulaStatusInfo[], statusCounts: ReturnType<typeof calculateStatusCounts>) {
  const totalFormulas = formulas.length;
  
  console.log('');
  console.log(`Summary: ${statusCounts.installed}/${totalFormulas} installed`);
  
  if (statusCounts.missing > 0) {
    console.log(`❌ ${statusCounts.missing} formulas missing from ai directory`);
  }
  
  if (statusCounts.mismatch > 0) {
    console.log(`⚠️  ${statusCounts.mismatch} formulas have version mismatches`);
  }
  
  if (statusCounts.updateAvailable > 0) {
    console.log(`🔄 ${statusCounts.updateAvailable} formulas have updates available`);
  }
  
  if (statusCounts.registryUnavailable > 0) {
    console.log(`⚠️  ${statusCounts.registryUnavailable} formulas not found in registry`);
  }
  
  if (statusCounts.structureInvalid > 0) {
    console.log(`⚠️  ${statusCounts.structureInvalid} formulas have structure issues`);
  }
  
  // Show actionable recommendations
  if (totalFormulas === 0) {
    console.log('');
    console.log('💡 Tips:');
    console.log('• Add formulas to formula.yml and run "g0 install" to install them');
    console.log('• Use "g0 list" to see available formulas in the registry');
    console.log('• Run "g0 init" to initialize this as a formula project');
  } else {
    const hasIssues = statusCounts.missing + statusCounts.mismatch + statusCounts.structureInvalid > 0;
    if (hasIssues) {
      console.log('');
      console.log('💡 Recommended actions:');
      
      if (statusCounts.missing > 0) {
        console.log('• Run "g0 install" to install missing formulas');
      }
      
      if (statusCounts.updateAvailable > 0) {
        console.log('• Run "g0 install --force <formula-name>" to update specific formulas');
      }
      
      if (statusCounts.structureInvalid > 0) {
        console.log('• Run "g0 install --force" to repair structure issues');
      }
      
      if (statusCounts.registryUnavailable > 0) {
        console.log('• Check if missing formulas exist in remote registry with "g0 search"');
      }
    }
  }
}

/**
 * Enhanced status command implementation with comprehensive analysis
 */
async function statusCommand(options: CommandOptions = {}): Promise<CommandResult> {
  const cwd = process.cwd();
  logger.info(`Checking formula status for directory: ${cwd}`, { options });
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  try {
    const { projectInfo, formulas } = await performStatusAnalysis(cwd, {
      registry: options.registry,
      platforms: options.platforms
    });
    
    // Display results
    console.log(`📁 Formula status for: ${cwd}`);
    console.log('');
    
    if (options.flat) {
      renderFlatView(formulas, { registry: options.registry });
    } else {
      renderTreeView(projectInfo, formulas, { 
        depth: options.depth, 
        platforms: options.platforms 
      });
    }
    
    // Calculate and display status summary
    const statusCounts = calculateStatusCounts(formulas);
    displayStatusSummary(formulas, statusCounts);
    
    // Show repair suggestions if requested
    if (options.repair) {
      console.log('');
      console.log('🔧 Repair suggestions:');
      // TODO: Add specific repair recommendations based on issues found
    }
    
    return {
      success: true,
      data: {
        projectInfo,
        formulas,
        summary: statusCounts
      }
    };
  } catch (error) {
    logger.error('Status command failed', { error, cwd });
    throw error;
  }
}

/**
 * Setup the enhanced status command
 */
export function setupStatusCommand(program: Command): void {
  program
    .command('status')
    .description('Show comprehensive formula status for the current project')
    .option('--flat', 'show flat table view instead of tree view')
    .option('--depth <number>', 'limit tree depth (default: unlimited)', parseInt)
    .option('--registry', 'check registry for available updates')
    .option('--platforms', 'show platform-specific status information')
    .option('--repair', 'show repair suggestions without applying them')
    .action(withErrorHandling(async (options: CommandOptions) => {
      await statusCommand(options);
    }));
}
