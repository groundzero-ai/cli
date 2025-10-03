import { Command } from 'commander';
import { join, dirname } from 'path';
import * as semver from 'semver';
import { CommandResult, FormulaYml, FormulaDependency } from '../types/index.js';
import { parseFormulaYml, parseMarkdownFrontmatter } from '../utils/formula-yml.js';
import { ensureRegistryDirectories, listFormulaVersions } from '../core/directory.js';
import { GroundzeroFormula, gatherGlobalVersionConstraints } from '../core/groundzero.js';
import { resolveDependencies } from '../core/dependency-resolver.js';
import { registryManager } from '../core/registry.js';
import { exists, listDirectories, walkFiles, readTextFile } from '../utils/fs.js';
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
  FILE_PATTERNS, 
  UNIVERSAL_SUBDIRS, 
  DEPENDENCY_ARRAYS,
  PLATFORM_DIRS,
  FORMULA_DIRS
} from '../constants/index.js';
import { getPlatformDefinition, detectAllPlatforms } from '../core/platforms.js';

/**
 * Formula status types
 */
type FormulaStatus = 'installed' | 'outdated' | 'missing' | 'dependency-mismatch' | 'registry-unavailable' | 'structure-invalid' | 'platform-mismatch' | 'update-available' | 'files-missing' | 'orphaned-files' | 'frontmatter-mismatch';
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
  fileSummary?: {
    aiFiles: { found: number; paths: string[] };
    platformFiles: Record<string, {
      rules?: { found: number };
      commands?: { found: number };
      agents?: { found: number };
    }>;
  };
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
  verbose?: boolean;
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
  const detections = await detectAllPlatforms(cwd);
  const checks = detections.map(async ({ name, detected }) => {
    const def = getPlatformDefinition(name as any);
    const rootAbs = join(cwd, def.rootDir);
    const rulesDef = def.subdirs[UNIVERSAL_SUBDIRS.RULES];
    const rulesAbs = rulesDef ? join(rootAbs, rulesDef.path) : undefined;
    const writeExt = rulesDef?.writeExt || '.md';
    const gzTemplate = rulesAbs ? join(rulesAbs, `groundzero${writeExt}`) : undefined;
    const aiTemplate = rulesAbs ? join(rulesAbs, `ai${writeExt}`) : undefined;

    const [dirExists, gzExists, aiExists] = await Promise.all([
      exists(rootAbs),
      gzTemplate ? exists(gzTemplate) : Promise.resolve(false),
      aiTemplate ? exists(aiTemplate) : Promise.resolve(false)
    ]);

    return {
      name,
      detected: detected && dirExists,
      configured: detected && dirExists,
      directoryExists: dirExists,
      templatesPresent: Boolean(gzExists || aiExists)
    };
  });
  return Promise.all(checks);
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

  // Case 1: Formula not found by scanner
  if (!availableFormula) {
    if (localMetadata) {
      status.status = 'files-missing';
      status.issues = [`Formula '${requiredFormula.name}' has local metadata but no files detected in ai or platforms`];
    } else {
      status.status = 'missing';
      status.issues = [`Formula '${requiredFormula.name}' not found in ai or platforms`];
    }
    
    // Check for registry updates if available
    if (registryCheck && status.registryVersion && status.status === 'missing') {
      status.status = 'update-available';
      status.issues?.push(`Version ${status.registryVersion} available in registry`);
    }
    
    return status;
  }

  // Case 2: Formula exists - compare versions  
  status.availableVersion = localMetadata?.version || availableFormula.version;
  status.path = availableFormula.path;

  const requiredVersion = requiredFormula.version;
  const installedVersion = availableFormula.version;
  // Ensure displayed version reflects the actual installed/detected version
  status.installedVersion = installedVersion;

  // If local metadata is missing, likely .groundzero/formulas/<name>/formula.yml is missing or misnamed
  if (!localMetadata) {
    const projectRoot = dirname(dirname(availableFormula.path));
    const metaDir = join(projectRoot, PLATFORM_DIRS.GROUNDZERO, FORMULA_DIRS.FORMULAS, requiredFormula.name);
    status.status = 'files-missing';
    status.issues = [`'${FILE_PATTERNS.FORMULA_YML}' is missing or misnamed`];
    // Avoid confusing 0.0.0 display when metadata is missing
    status.installedVersion = requiredVersion;
    return status;
  }
  
  // Support multiple constraints joined by ' & ' (logical AND)
  const requiredRanges = requiredVersion.includes('&')
    ? requiredVersion.split('&').map(s => s.trim()).filter(Boolean)
    : [requiredVersion];

  // Check version compatibility
  try {
    const satisfiesAll = requiredRanges.every(range => satisfiesVersion(installedVersion, range));
    if (satisfiesAll) {
      status.status = 'installed';
      
      // Check for registry updates if requested
      if (registryCheck && status.registryVersion && semver.gt(status.registryVersion, installedVersion)) {
        status.status = 'update-available';
        status.issues = [`Newer version ${status.registryVersion} available in registry`];
      }
    } else {
      // Determine version mismatch type
      if (requiredRanges.length === 1 && isExactVersion(requiredRanges[0])) {
        status.status = semver.gt(installedVersion, requiredRanges[0]) ? 'outdated' : 'dependency-mismatch';
        const comparison = semver.gt(installedVersion, requiredRanges[0]) ? 'newer than' : 'older than';
        status.issues = [`Installed version ${installedVersion} is ${comparison} required ${requiredRanges[0]}`];
      } else {
        status.status = 'dependency-mismatch';
        status.issues = [
          `Installed version ${installedVersion} does not satisfy range ${requiredVersion} (${requiredRanges.map(describeVersionRange).join(' & ')})`
        ];
      }
    }
  } catch (error) {
    status.status = 'dependency-mismatch';
    status.issues = [`Version analysis failed: ${error}`];
  }
  
  // Validate local metadata consistency (only flag when exact version is required)
  if (localMetadata && localMetadata.version !== installedVersion && isExactVersion(requiredVersion)) {
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
  
  // 3. Scan installed files by frontmatter and read local metadata in parallel
  const [detectedByFrontmatter, localMetadata] = await Promise.all([
    scanInstalledFormulasByFrontmatter(cwd),
    scanLocalFormulaMetadata(cwd)
  ]);

  // Build availability map using detection results, preferring metadata versions when present
  const availableFormulas = new Map<string, GroundzeroFormula>();
  for (const [name, det] of detectedByFrontmatter) {
    const meta = localMetadata.get(name);
    availableFormulas.set(name, {
      name,
      version: meta?.version || '0.0.0',
      path: det.anyPath || join(aiDir, name)
    } as GroundzeroFormula);
  }
  
  // 4. Analyze all formulas in parallel
  const allFormulas = [
    ...(cwdConfig.formulas || []).map(f => ({ ...f, type: 'formula' as FormulaType })),
    ...(cwdConfig[DEPENDENCY_ARRAYS.DEV_FORMULAS] || []).map(f => ({ ...f, type: 'dev-formula' as FormulaType }))
  ];
  
  const analysisPromises = allFormulas.map(async (formula) => {
    const available = availableFormulas.get(formula.name) || null;
    const localMeta = localMetadata.get(formula.name) || null;
    const status = await analyzeFormulaStatus(formula, available, localMeta, formula.type, options.registry);
    const detected = detectedByFrontmatter.get(formula.name);
    if (detected) {
      status.fileSummary = {
        aiFiles: { found: detected.aiFiles.length, paths: detected.aiFiles },
        platformFiles: detected.platforms
      };
    }
    
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
  'platform-mismatch': '⚠️',
  'files-missing': '⚠️',
  'orphaned-files': '⚠️',
  'frontmatter-mismatch': '⚠️'
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
    case 'files-missing':
      return ' (files missing)';
    case 'orphaned-files':
      return ' (orphaned files)';
    case 'frontmatter-mismatch':
      return ' (frontmatter mismatch)';
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

  // Optional file-level summary (verbose)
  if ((formula as any).fileSummary && (globalThis as any).__statusVerbose) {
    const fsPrefix = prefix + (isLast ? '    ' : '│   ');
    const fs = (formula as any).fileSummary as NonNullable<FormulaStatusInfo['fileSummary']>;
    console.log(`${fsPrefix}📄 ai files: ${fs.aiFiles.found}`);
    const platforms = Object.keys(fs.platformFiles || {});
    if (platforms.length > 0) {
      console.log(`${fsPrefix}🖥️ platform files:`);
      for (const p of platforms) {
        const pf = (fs.platformFiles as any)[p] || {};
        const parts: string[] = [];
        if (pf.rules?.found) parts.push(`rules:${pf.rules.found}`);
        if (pf.commands?.found) parts.push(`commands:${pf.commands.found}`);
        if (pf.agents?.found) parts.push(`agents:${pf.agents.found}`);
        console.log(`${fsPrefix}   - ${p} ${parts.length ? `(${parts.join(', ')})` : ''}`);
      }
    }
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
  // Set a global verbose flag for renderer (avoids threading through many calls)
  (globalThis as any).__statusVerbose = Boolean(options.verbose);
  
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
    .description('Show comprehensive formula status for the current project (ai files, platform templates, and dependencies)')
    .option('--flat', 'show flat table view instead of tree view')
    .option('--depth <number>', 'limit tree depth (default: unlimited)', parseInt)
    .option('--registry', 'check registry for available updates')
    .option('--platforms', 'show platform-specific status information')
    .option('--repair', 'show repair suggestions without applying them')
    .option('--verbose', 'show file-level details')
    .action(withErrorHandling(async (options: CommandOptions) => {
      await statusCommand(options);
    }));
}

/**
 * Scan installed formulas by parsing frontmatter across ai and platform directories
 */
async function scanInstalledFormulasByFrontmatter(cwd: string): Promise<Map<string, { aiFiles: string[]; platforms: Record<string, { rules?: { found: number }; commands?: { found: number }; agents?: { found: number } }>; anyPath?: string }>> {
  const result = new Map<string, { aiFiles: string[]; platforms: Record<string, { rules?: { found: number }; commands?: { found: number }; agents?: { found: number } }>; anyPath?: string }>();

  const aiDir = getAIDir(cwd);
  if (await exists(aiDir)) {
    for await (const filePath of walkFiles(aiDir)) {
      if (!filePath.endsWith(FILE_PATTERNS.MD_FILES) && !filePath.endsWith(FILE_PATTERNS.MDC_FILES)) {
        continue;
      }
      try {
        const content = await readTextFile(filePath);
        const fm = parseMarkdownFrontmatter(content);
        const formulaName: string | undefined = (fm as any)?.formula?.name || (fm as any)?.formula;
        if (formulaName) {
          if (!result.has(formulaName)) {
            result.set(formulaName, { aiFiles: [], platforms: {}, anyPath: dirname(filePath) });
          }
          const entry = result.get(formulaName)!;
          entry.aiFiles.push(filePath);
          if (!entry.anyPath) entry.anyPath = dirname(filePath);
        }
      } catch {}
    }
  }

  const detections = await detectAllPlatforms(cwd);
  for (const { name: platform, detected } of detections) {
    if (!detected) continue;
    const def = getPlatformDefinition(platform as any);
    const platformRoot = join(cwd, def.rootDir);

    for (const [subKey, subDef] of Object.entries(def.subdirs)) {
      const targetDir = join(platformRoot, (subDef as any).path || '');
      if (!(await exists(targetDir))) continue;
      for await (const fp of walkFiles(targetDir)) {
        const allowedExts: string[] = ((subDef as any).readExts) || [FILE_PATTERNS.MD_FILES];
        if (!allowedExts.some((ext) => fp.endsWith(ext))) continue;
        try {
          const content = await readTextFile(fp);
          const fm = parseMarkdownFrontmatter(content);
          const formulaName: string | undefined = (fm as any)?.formula?.name || (fm as any)?.formula;
          if (!formulaName) continue;
          if (!result.has(formulaName)) {
            result.set(formulaName, { aiFiles: [], platforms: {}, anyPath: dirname(fp) });
          }
          const entry = result.get(formulaName)!;
          entry.platforms[platform] = entry.platforms[platform] || {};
          if (subKey === UNIVERSAL_SUBDIRS.RULES) {
            entry.platforms[platform].rules = entry.platforms[platform].rules || { found: 0 };
            entry.platforms[platform].rules!.found++;
          } else if (subKey === UNIVERSAL_SUBDIRS.COMMANDS) {
            entry.platforms[platform].commands = entry.platforms[platform].commands || { found: 0 };
            entry.platforms[platform].commands!.found++;
          } else if (subKey === UNIVERSAL_SUBDIRS.AGENTS) {
            entry.platforms[platform].agents = entry.platforms[platform].agents || { found: 0 };
            entry.platforms[platform].agents!.found++;
          }
          if (!entry.anyPath) entry.anyPath = dirname(fp);
        } catch {}
      }
    }
  }

  return result;
}
