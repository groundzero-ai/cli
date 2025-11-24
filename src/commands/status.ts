import { Command } from 'commander';
import { join } from 'path';
import * as semver from 'semver';
import { CommandResult, PackageYml, PackageDependency } from '../types/index.js';
import { parsePackageYml } from '../utils/package-yml.js';
import { ensureRegistryDirectories, listPackageVersions } from '../core/directory.js';
import { GroundzeroPackage, gatherGlobalVersionConstraints, gatherRootVersionConstraints } from '../core/openpackage.js';
import { resolveDependencies } from '../core/dependency-resolver.js';
import { registryManager } from '../core/registry.js';
import { exists } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, ValidationError } from '../utils/errors.js';
import {
  getLocalPackageYmlPath,
  getLocalPackagesDir,
  getLocalOpenPackageDir,
  getAIDir
} from '../utils/paths.js';
import { 
  satisfiesVersion, 
  isExactVersion, 
  describeVersionRange
} from '../utils/version-ranges.js';
import { 
  FILE_PATTERNS, 
  DEPENDENCY_ARRAYS,
} from '../constants/index.js';
import { getPlatformDefinition, detectAllPlatforms } from '../core/platforms.js';
import { findDirectoriesContainingFile } from '../utils/file-processing.js';
import { discoverPackagesForStatus } from '../core/status/status-file-discovery.js';
import { normalizePackageName } from '../utils/package-name.js';

/**
 * Package status types
 */
type PackageStatus = 'installed' | 'outdated' | 'missing' | 'dependency-mismatch' | 'registry-unavailable' | 'structure-invalid' | 'platform-mismatch' | 'update-available' | 'files-missing' | 'orphaned-files' | 'frontmatter-mismatch';
type PackageType = 'package' | 'dev-package' | 'dependency';

/**
 * Enhanced package status interface
 */
interface PackageStatusInfo {
  name: string;
  installedVersion: string;
  availableVersion?: string;
  registryVersion?: string;
  status: PackageStatus;
  type: PackageType;
  dependencies?: PackageStatusInfo[];
  path?: string;
  issues?: string[];
  conflictResolution?: string;
  fileSummary?: {
    aiFiles: { found: number; paths: string[] };
    platformFiles: Record<string, {
      rules?: { found: number };
      commands?: { found: number };
      agents?: { found: number };
      skills?: { found: number };
    }>;
    rootFiles?: { found: number; paths: string[] };
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
}

/**
 * Project status information
 */
interface ProjectStatus {
  name: string;
  version: string;
  openpackageExists: boolean;
  packageYmlExists: boolean;
  packagesDirectoryExists: boolean;
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
 * Scan local package metadata from .openpackage/packages directory
 * Recursively scans to handle scoped packages (e.g., @scope/name)
 */
async function scanLocalPackageMetadata(cwd: string): Promise<Map<string, PackageYml>> {
  const packagesDir = getLocalPackagesDir(cwd);
  const localPackages = new Map<string, PackageYml>();
  
  if (!(await exists(packagesDir))) {
    return localPackages;
  }
  
  try {
    // Use the generic recursive scanner to find all pkg.yml files
    const packageDirs = await findDirectoriesContainingFile(
      packagesDir,
      FILE_PATTERNS.PACKAGE_YML,
      async (filePath) => {
        try {
          return await parsePackageYml(filePath);
        } catch (error) {
          logger.warn(`Failed to parse local package metadata: ${filePath}`, { error });
          return null;
        }
      }
    );

    // Build the map from results
    for (const result of packageDirs) {
      if (result.parsedContent) {
        localPackages.set(result.parsedContent.name, result.parsedContent);
      }
    }
  } catch (error) {
    logger.error('Failed to scan local package metadata', { error, packagesDir });
  }
  
  return localPackages;
}

/**
 * Detect platform status and configuration
 */
async function detectPlatformStatus(cwd: string): Promise<PlatformStatus[]> {
  const detections = await detectAllPlatforms(cwd);
  const checks = detections.map(async ({ name, detected }) => {
    const def = getPlatformDefinition(name as any);
    const rootAbs = join(cwd, def.rootDir);

    const [dirExists] = await Promise.all([
      exists(rootAbs)
    ]);

    return {
      name,
      detected: detected && dirExists,
      configured: detected && dirExists,
      directoryExists: dirExists
    };
  });
  return Promise.all(checks);
}

/**
 * Check registry for available versions
 */
async function checkRegistryVersions(packageName: string): Promise<{ latest?: string; available: string[] }> {
  try {
    const [hasPackage, metadata, available] = await Promise.all([
      registryManager.hasPackage(packageName),
      registryManager.getPackageMetadata(packageName).catch(() => null),
      listPackageVersions(packageName).catch(() => [])
    ]);
    
    if (!hasPackage) {
      return { available: [] };
    }
    
    return {
      latest: metadata?.version,
      available: available || []
    };
  } catch (error) {
    logger.debug(`Failed to check registry for package ${packageName}`, { error });
    return { available: [] };
  }
}

/**
 * Analyze status of a single package with enhanced checks
 */
async function analyzePackageStatus(
  requiredPackage: PackageDependency,
  availablePackage: GroundzeroPackage | null,
  localMetadata: PackageYml | null,
  type: PackageType,
  registryCheck: boolean = false
): Promise<PackageStatusInfo> {
  const status: PackageStatusInfo = {
    name: requiredPackage.name,
    installedVersion: requiredPackage.version,
    type,
    status: 'missing'
  };
  
  // Check registry if requested
  if (registryCheck) {
    const registryInfo = await checkRegistryVersions(requiredPackage.name);
    status.registryVersion = registryInfo.latest;
    
    if (registryInfo.available.length === 0) {
      status.status = 'registry-unavailable';
      status.issues = [`Package '${requiredPackage.name}' not found in registry`];
      return status;
    }
  }

  // Case 1: Package not found by scanner
  if (!availablePackage) {
    if (localMetadata) {
      status.status = 'files-missing';
      status.issues = [`Package '${requiredPackage.name}' has local metadata but no files detected`];
    } else {
      status.status = 'missing';
      status.issues = [`Package '${requiredPackage.name}' not found`];
    }
    
    // Check for registry updates if available
    if (registryCheck && status.registryVersion && status.status === 'missing') {
      status.status = 'update-available';
      status.issues?.push(`Version ${status.registryVersion} available in registry`);
    }
    
    return status;
  }

  // Case 2: Package exists - compare versions  
  status.availableVersion = localMetadata?.version || availablePackage.version;
  status.path = availablePackage.path;

  const requiredVersion = requiredPackage.version;
  const installedVersion = availablePackage.version;
  // Ensure displayed version reflects the actual installed/detected version
  status.installedVersion = installedVersion;

  // If local metadata is missing, likely .openpackage/packages/<name>/pkg.yml is missing or misnamed
  if (!localMetadata) {
    status.status = 'files-missing';
    status.issues = [`'${FILE_PATTERNS.PACKAGE_YML}' is missing or misnamed`];
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
async function buildPackageDependencyTree(
  packageName: string,
  cwd: string,
  availablePackages: Map<string, GroundzeroPackage>,
  localMetadata: Map<string, PackageYml>,
  version?: string,
  registryCheck: boolean = false
): Promise<PackageStatusInfo[]> {
  try {
    // Use the install command's dependency resolver to get the complete tree
    const constraints = await gatherGlobalVersionConstraints(cwd);
    const rootConstraints = await gatherRootVersionConstraints(cwd);
    const result = await resolveDependencies(
      packageName,
      cwd,
      true,
      new Set(),
      new Map(),
      version,
      new Map(),
      constraints,
      rootConstraints
    );
    const resolvedPackages = result.resolvedPackages;
    const missingPackages = result.missingPackages;

    // Convert resolved packages to status info in parallel
    const dependencyPromises = resolvedPackages
      .filter(resolved => !resolved.isRoot) // Skip the root package
      .map(async (resolved) => {
        const availablePackage = availablePackages.get(resolved.name) || null;
        const localMeta = localMetadata.get(resolved.name) || null;
        
        const dependency: PackageDependency = {
          name: resolved.name,
          version: resolved.requiredRange || resolved.version
        };
        
        const depStatus = await analyzePackageStatus(
          dependency,
          availablePackage,
          localMeta,
          'dependency',
          registryCheck
        );
        
        if (resolved.conflictResolution) {
          depStatus.conflictResolution = resolved.conflictResolution;
        }
        
        return depStatus;
      });

    // Add status info for missing packages
    const missingPromises = missingPackages.map(async (missingName) => {
      const dependency: PackageDependency = {
        name: missingName,
        version: 'latest'
      };

      return await analyzePackageStatus(
        dependency,
        null, // no available package
        null, // no local metadata
        'dependency',
        registryCheck
      );
    });

    const allPromises = [...dependencyPromises, ...missingPromises];
    return Promise.all(allPromises);
  } catch (error) {
    logger.warn(`Failed to resolve dependencies for ${packageName}`, { error });
    
    // Fallback to basic dependency scanning
    const pkg = availablePackages.get(packageName);
    if (!pkg?.packages) {
      return [];
    }
    
    const fallbackPromises = pkg.packages.map(async (dep) => {
      const availableDep = availablePackages.get(dep.name) || null;
      const localMeta = localMetadata.get(dep.name) || null;
      return analyzePackageStatus(dep, availableDep, localMeta, 'dependency', registryCheck);
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
  packages: PackageStatusInfo[];
}> {
  // 1. Check basic project structure in parallel
  const [openpackageDir, packageYmlPath, packagesDir, aiDir] = [
    getLocalOpenPackageDir(cwd),
    getLocalPackageYmlPath(cwd),
    getLocalPackagesDir(cwd),
    getAIDir(cwd)
  ];
  
  const [openpackageExists, packageYmlExists, packagesDirExists, aiDirExists] = await Promise.all([
    exists(openpackageDir),
    exists(packageYmlPath),
    exists(packagesDir),
    exists(aiDir)
  ]);
  
  if (!openpackageExists || !packageYmlExists) {
    throw new ValidationError(
      `No .openpackage/pkg.yml found in ${cwd}. This directory doesn't appear to be a package project.\n\n` +
      `💡 To initialize this as a package project:\n` +
      `   • Run 'opkg init' to create a new package project\n` +
      `   • Run 'opkg install' to install existing packages`
    );
  }
  
  // 2. Parse main pkg.yml and detect platforms in parallel
  const [cwdConfig, platformStatuses] = await Promise.all([
    parsePackageYml(packageYmlPath).catch(error => {
      throw new ValidationError(`Failed to parse pkg.yml: ${error}`);
    }),
    options.platforms ? detectPlatformStatus(cwd) : Promise.resolve([])
  ]);
  
  // 3. Discover installed files using same method as uninstall and read local metadata in parallel
  // First collect all package names including dependencies
  const packageNames = new Set<string>([
    ...(cwdConfig.packages || []).map(f => normalizePackageName(f.name)),
    ...(cwdConfig[DEPENDENCY_ARRAYS.PACKAGES] || []).map(f => normalizePackageName(f.name))
  ]);

  // Resolve dependencies for each package to get their names
  for (const pkg of cwdConfig.packages || []) {
    try {
      const constraints = await gatherGlobalVersionConstraints(cwd);
      const rootConstraints = await gatherRootVersionConstraints(cwd);
      const result = await resolveDependencies(
        pkg.name,
        cwd,
        true,
        new Set(),
        new Map(),
        pkg.version,
        new Map(),
        constraints,
        rootConstraints
      );
      const resolvedPackages = result.resolvedPackages;
      const missingPackages = result.missingPackages;

      // Add all resolved dependency names to the set
      for (const resolved of resolvedPackages) {
        if (!resolved.isRoot) {
          packageNames.add(normalizePackageName(resolved.name));
        }
      }

      // Add missing package names to the set
      for (const missing of missingPackages) {
        packageNames.add(normalizePackageName(missing));
      }
    } catch (error) {
      logger.debug(`Failed to resolve dependencies for ${pkg.name}`, { error });
    }
  }

  const [detectedByFrontmatter, localMetadata] = await Promise.all([
    discoverPackagesForStatus(Array.from(packageNames)),
    scanLocalPackageMetadata(cwd)
  ]);

  // Build availability map using detection results, preferring metadata versions when present
  const availablePackages = new Map<string, GroundzeroPackage>();
  for (const [name, det] of detectedByFrontmatter) {
    const meta = localMetadata.get(name);
    availablePackages.set(name, {
      name,
      version: meta?.version || '0.0.0',
      path: det.anyPath || join(aiDir, name)
    } as GroundzeroPackage);
  }
  
  // 4. Analyze all packages in parallel
  const allPackages = [
    ...(cwdConfig.packages || []).map(f => ({ ...f, type: 'package' as PackageType })),
    ...(cwdConfig[DEPENDENCY_ARRAYS.DEV_PACKAGES] || []).map(f => ({ ...f, type: 'dev-package' as PackageType }))
  ];
  
  const analysisPromises = allPackages.map(async (pkg) => {
    const available = availablePackages.get(pkg.name) || null;
    const localMeta = localMetadata.get(pkg.name) || null;
    const status = await analyzePackageStatus(pkg, available, localMeta, pkg.type, options.registry);
    const detected = detectedByFrontmatter.get(pkg.name);
    if (detected) {
      status.fileSummary = {
        aiFiles: { found: detected.aiFiles.length, paths: detected.aiFiles },
        platformFiles: detected.platforms,
        rootFiles: detected.rootFiles ? { found: detected.rootFiles.length, paths: detected.rootFiles } : undefined
      };
    }
    
    // Build dependency tree if installed
    if (status.status === 'installed') {
      try {
        status.dependencies = await buildPackageDependencyTree(
          pkg.name,
          cwd,
          availablePackages,
          localMetadata,
          pkg.version,
          options.registry
        );
      } catch (error) {
        logger.warn(`Failed to build dependency tree for ${pkg.name}`, { error });
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
    openpackageExists,
    packageYmlExists,
    packagesDirectoryExists: packagesDirExists,
    aiDirectoryExists: aiDirExists,
    platforms: platformStatuses
  };
  
  return {
    projectInfo,
    packages: results
  };
}

/**
 * Render enhanced tree view of packages with status
 */
function renderTreeView(
  projectInfo: ProjectStatus,
  packages: PackageStatusInfo[],
  options: { depth?: number; platforms?: boolean } = {}
): void {
  // Project header with status indicators
  const statusIndicators = [
    !projectInfo.openpackageExists && '❌ .openpackage missing',
    !projectInfo.packageYmlExists && '❌ pkg.yml missing',
    !projectInfo.aiDirectoryExists && '⚠️ ai directory missing'
  ].filter(Boolean);
  
  const statusSuffix = statusIndicators.length > 0 ? ` (${statusIndicators.join(', ')})` : '';
  console.log(`${projectInfo.name}@${projectInfo.version}${statusSuffix}`);
  
  // Platform information if requested
  if (options.platforms && projectInfo.platforms.length > 0) {
    console.log('\n✓ Platforms:');
    for (const platform of projectInfo.platforms) {
      const status = platform.detected ? '✅' : '❌';
      console.log(`  ${status} ${platform.name}`);
    }
  }
  
  if (packages.length === 0) {
    console.log('\n└── (no packages)');
    return;
  }
  
  packages.forEach((pkg, i) => {
    const isLast = i === packages.length - 1;
    renderPackageTree(pkg, '', isLast, options.depth, 1);
  });
}

/**
 * Status icon and suffix mapping
 */
const STATUS_ICONS: Record<PackageStatus, string> = {
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
function getStatusSuffix(pkg: PackageStatusInfo): string {
  switch (pkg.status) {
    case 'missing':
      return ' (missing)';
    case 'outdated':
      return ` (outdated: ${pkg.availableVersion} available)`;
    case 'dependency-mismatch':
      return ' (version mismatch)';
    case 'update-available':
      return pkg.registryVersion ? ` (update: ${pkg.registryVersion})` : ' (update available)';
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
 * Render individual package in enhanced tree format
 */
function renderPackageTree(
  pkg: PackageStatusInfo,
  prefix: string,
  isLast: boolean,
  maxDepth?: number,
  currentDepth: number = 1
): void {
  const connector = isLast ? '└── ' : '├── ';
  const typePrefix = pkg.type === 'dev-package' ? '[dev] ' : '';
  const statusIcon = STATUS_ICONS[pkg.status] || '❓';
  const statusSuffix = getStatusSuffix(pkg);
  const conflictInfo = pkg.conflictResolution ? ` [${pkg.conflictResolution}]` : '';
  
  console.log(`${prefix}${connector}${statusIcon} ${typePrefix}${pkg.name}@${pkg.installedVersion}${statusSuffix}${conflictInfo}`);
  
  // Show issues if any
  if (pkg.issues?.length) {
    const issuePrefix = prefix + (isLast ? '    ' : '│   ');
    pkg.issues.forEach(issue => {
      console.log(`${issuePrefix}⚠️  ${issue}`);
    });
  }

  // Optional file-level summary (verbose)
  if ((pkg as any).fileSummary && (globalThis as any).__statusVerbose) {
    const fsPrefix = prefix + (isLast ? '    ' : '│   ');
    const fs = (pkg as any).fileSummary as NonNullable<PackageStatusInfo['fileSummary']>;
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
    if (fs.rootFiles && fs.rootFiles.found > 0) {
      console.log(`${fsPrefix}📁 root files: ${fs.rootFiles.found}`);
    }
  }
  
  // Show dependencies if within depth limit
  if (pkg.dependencies?.length) {
    if (!maxDepth || currentDepth < maxDepth) {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      pkg.dependencies.forEach((dep, j) => {
        const isLastChild = j === pkg.dependencies!.length - 1;
        renderPackageTree(dep, childPrefix, isLastChild, maxDepth, currentDepth + 1);
      });
    } else {
      const childPrefix = prefix + (isLast ? '    ' : '│   ');
      console.log(`${childPrefix}└── (${pkg.dependencies.length} dependencies - use --depth to see more)`);
    }
  }
}

/**
 * Collect all packages including dependencies recursively
 */
function collectAllPackages(packages: PackageStatusInfo[]): PackageStatusInfo[] {
  const allPackages: PackageStatusInfo[] = [];
  
  function collect(packageList: PackageStatusInfo[]) {
    for (const pkg of packageList) {
      allPackages.push(pkg);
      if (pkg.dependencies) {
        collect(pkg.dependencies);
      }
    }
  }
  
  collect(packages);
  return allPackages;
}

/**
 * Render enhanced flat table view of packages
 */
function renderFlatView(packages: PackageStatusInfo[], options: { registry?: boolean } = {}): void {
  if (packages.length === 0) {
    console.log('No packages found.');
    return;
  }
  
  const allPackages = collectAllPackages(packages);
  
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
  
  // Display each package
  allPackages.forEach(pkg => {
    const values = [
      pkg.name.padEnd(widths[0]),
      pkg.installedVersion.padEnd(widths[1]),
      pkg.status.padEnd(widths[2]),
      pkg.type.padEnd(widths[3])
    ];
    
    if (options.registry) {
      values.push((pkg.registryVersion || '-').padEnd(widths[4]));
    }
    
    const issues = pkg.issues ? pkg.issues.slice(0, 2).join('; ') : '-';
    values.push(issues.length > 27 ? issues.substring(0, 24) + '...' : issues);
    
    console.log(values.join(''));
  });
  
  console.log('\nTotal: ${allPackages.length} packages');
  
  // Summary by status
  const statusCounts = new Map<string, number>();
  allPackages.forEach(pkg => {
    statusCounts.set(pkg.status, (statusCounts.get(pkg.status) || 0) + 1);
  });
  
  console.log('\nStatus Summary:');
  statusCounts.forEach((count, status) => {
    console.log(`  ${status}: ${count}`);
  });
}

/**
 * Calculate status counts efficiently
 */
function calculateStatusCounts(packages: PackageStatusInfo[]) {
  const counts = {
    installed: 0,
    missing: 0,
    outdated: 0,
    mismatch: 0,
    updateAvailable: 0,
    registryUnavailable: 0,
    structureInvalid: 0
  };
  
  packages.forEach(pkg => {
    switch (pkg.status) {
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
function displayStatusSummary(packages: PackageStatusInfo[], statusCounts: ReturnType<typeof calculateStatusCounts>) {
  const totalPackages = packages.length;
  
  console.log(`Summary: ${statusCounts.installed}/${totalPackages} installed`);
  
  if (statusCounts.missing > 0) {
    console.log(`❌ ${statusCounts.missing} packages missing from ai directory`);
  }
  
  if (statusCounts.mismatch > 0) {
    console.log(`⚠️  ${statusCounts.mismatch} packages have version mismatches`);
  }
  
  if (statusCounts.updateAvailable > 0) {
    console.log(`✓ ${statusCounts.updateAvailable} packages have updates available`);
  }
  
  if (statusCounts.registryUnavailable > 0) {
    console.log(`⚠️  ${statusCounts.registryUnavailable} packages not found in registry`);
  }
  
  if (statusCounts.structureInvalid > 0) {
    console.log(`⚠️  ${statusCounts.structureInvalid} packages have structure issues`);
  }
  
  // Show actionable recommendations
  if (totalPackages === 0) {
    console.log('');
    console.log('💡 Tips:');
    console.log('• Add packages to pkg.yml and run "opkg install" to install them');
    console.log('• Use "opkg list" to see available packages in the registry');
    console.log('• Run "opkg init" to initialize this as a package project');
  } else {
    const hasIssues = statusCounts.missing + statusCounts.mismatch + statusCounts.structureInvalid > 0;
    if (hasIssues) {
      console.log('');
      console.log('💡 Recommended actions:');
      
      if (statusCounts.missing > 0) {
        console.log('• Run "opkg install" to install missing packages');
      }
      
      if (statusCounts.updateAvailable > 0) {
        console.log('• Run "opkg install --force <package-name>" to update specific packages');
      }
      
      if (statusCounts.structureInvalid > 0) {
        console.log('• Run "opkg install --force" to repair structure issues');
      }
      
      if (statusCounts.registryUnavailable > 0) {
        console.log('• Check if missing packages exist in remote registry with "opkg search"');
      }
    }
  }
}

/**
 * Enhanced status command implementation with comprehensive analysis
 */
async function statusCommand(options: CommandOptions = {}): Promise<CommandResult> {
  const cwd = process.cwd();
  logger.info(`Checking package status for directory: ${cwd}`, { options });
  // Set a global verbose flag for renderer (avoids threading through many calls)
  (globalThis as any).__statusVerbose = Boolean(options.verbose);
  
  // Ensure registry directories exist
  await ensureRegistryDirectories();
  
  try {
    const { projectInfo, packages } = await performStatusAnalysis(cwd, {
      registry: options.registry,
      platforms: options.platforms
    });
    
    // Display results
    console.log(`✓ Package status for: ${cwd}`);
    
    if (options.flat) {
      renderFlatView(packages, { registry: options.registry });
    } else {
      renderTreeView(projectInfo, packages, { 
        depth: options.depth, 
        platforms: options.platforms 
      });
    }
    
    // Calculate and display status summary
    const statusCounts = calculateStatusCounts(packages);
    displayStatusSummary(packages, statusCounts);
    
    // Show repair suggestions if requested
    if (options.repair) {
      console.log('✓ Repair suggestions:');
      // TODO: Add specific repair recommendations based on issues found
    }
    
    return {
      success: true,
      data: {
        projectInfo,
        packages,
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
    .description('Show comprehensive package status for the current project (ai files, platform templates, and dependencies)')
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

