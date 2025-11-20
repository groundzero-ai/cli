import { join } from 'path';
import { PackageYml, PackageDependency } from '../types/index.js';
import { parsePackageYml } from '../utils/package-yml.js';
import { exists, isDirectory, listDirectories } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { FILE_PATTERNS, PLATFORM_DIRS } from '../constants/index.js';
import { getLocalPackageYmlPath, getLocalPackagesDir } from '../utils/paths.js';
import { findFilesByExtension, findDirectoriesContainingFile } from '../utils/file-processing.js';
import { getDetectedPlatforms, getPlatformDefinition, type Platform } from './platforms.js';
import { arePackageNamesEquivalent } from '../utils/package-name.js';

/**
 * Package metadata from openpackage directory
 */
export interface GroundzeroPackage {
  name: string;
  version: string;
  description?: string;
  formulas?: PackageDependency[];
  'dev-formulas'?: PackageDependency[];
  path: string;
}

/**
 * Find formula config file (.openpackage/formula.yml or formula.yml) in a directory
 */
async function findPackageConfigFile(directoryPath: string): Promise<string | null> {
  const openpackagePackageYmlPath = getLocalPackageYmlPath(directoryPath);
  const formulaYmlPath = join(directoryPath, FILE_PATTERNS.FORMULA_YML);
  
  if (await exists(openpackagePackageYmlPath)) {
    return openpackagePackageYmlPath;
  } else if (await exists(formulaYmlPath)) {
    return formulaYmlPath;
  }
  
  return null;
}

/**
 * Get the version of an installed formula by formula name
 */
export async function getInstalledPackageVersion(formulaName: string, targetDir: string): Promise<string | null> {
  const openpackagePath = join(targetDir, PLATFORM_DIRS.AI);
  const formulaGroundzeroPath = join(openpackagePath, formulaName);
  
  if (!(await exists(formulaGroundzeroPath))) {
    return null;
  }
  
  const configPath = await findPackageConfigFile(formulaGroundzeroPath);
  if (!configPath) {
    return null;
  }
  
  try {
    const config = await parsePackageYml(configPath);
    return config.version;
  } catch (error) {
    logger.warn(`Failed to parse formula config for ${formulaName}: ${error}`);
    return null;
  }
}

/**
 * Find formula directory in ai by matching formula name
 */
export async function findPackageDirectory(openpackagePath: string, formulaName: string): Promise<string | null> {
  if (!(await exists(openpackagePath)) || !(await isDirectory(openpackagePath))) {
    return null;
  }

  try {
    const subdirectories = await listDirectories(openpackagePath);
    
    for (const subdir of subdirectories) {
      const subdirPath = join(openpackagePath, subdir);
      const configPath = await findPackageConfigFile(subdirPath);
      
      if (configPath) {
        try {
          const formulaConfig = await parsePackageYml(configPath);
          if (arePackageNamesEquivalent(formulaConfig.name, formulaName)) {
            return subdirPath;
          }
        } catch (error) {
          logger.warn(`Failed to parse formula file ${configPath}: ${error}`);
        }
      }
    }
    
    return null;
  } catch (error) {
    logger.error(`Failed to search ai directory: ${error}`);
    return null;
  }
}

/**
 * Scan openpackage directory for all available formulas
 */
export async function scanGroundzeroPackages(openpackagePath: string): Promise<Map<string, GroundzeroPackage>> {
  const formulas = new Map<string, GroundzeroPackage>();

  if (!(await exists(openpackagePath)) || !(await isDirectory(openpackagePath))) {
    logger.debug('AI directory not found or not a directory', { openpackagePath });
    return formulas;
  }

  try {
    // Find all formula.yml files recursively under the formulas directory
    const formulasDir = getLocalPackagesDir(openpackagePath);
    if (!(await exists(formulasDir))) {
      return formulas;
    }

    const formulaDirs = await findDirectoriesContainingFile(
      formulasDir,
      FILE_PATTERNS.FORMULA_YML,
      async (filePath) => {
        try {
          return await parsePackageYml(filePath);
        } catch (error) {
          logger.warn(`Failed to parse formula file ${filePath}: ${error}`);
          return null;
        }
      }
    );

    for (const { dirPath, parsedContent } of formulaDirs) {
      if (parsedContent) {
        const formulaConfig = parsedContent;
        formulas.set(formulaConfig.name, {
          name: formulaConfig.name,
          version: formulaConfig.version,
          description: formulaConfig.description,
          formulas: formulaConfig.formulas || [],
          'dev-formulas': formulaConfig['dev-formulas'] || [],
          path: dirPath
        });
      }
    }
  } catch (error) {
    logger.error(`Failed to scan ai directory: ${error}`);
  }

  return formulas;
}

/**
 * Gather version constraints from the main and nested formula.yml files
 */
export async function gatherGlobalVersionConstraints(cwd: string, includeResolutions: boolean = true): Promise<Map<string, string[]>> {
  const constraints = new Map<string, Set<string>>();

  const addConstraint = (name?: string, range?: string) => {
    if (!name || !range) {
      return;
    }

    const trimmedName = name.trim();
    const trimmedRange = range.trim();

    if (!trimmedName || !trimmedRange) {
      return;
    }

    if (!constraints.has(trimmedName)) {
      constraints.set(trimmedName, new Set());
    }

    constraints.get(trimmedName)!.add(trimmedRange);
  };

  const collectFromConfig = (config: PackageYml | null | undefined) => {
    if (!config) {
      return;
    }

    config.formulas?.forEach(dep => addConstraint(dep.name, dep.version));
    config['dev-formulas']?.forEach(dep => addConstraint(dep.name, dep.version));
  };

  // Collect from main .openpackage/formula.yml if present
  const mainPackagePath = getLocalPackageYmlPath(cwd);
  if (await exists(mainPackagePath)) {
    try {
      const mainConfig = await parsePackageYml(mainPackagePath);
      collectFromConfig(mainConfig);
    } catch (error) {
      logger.debug(`Failed to parse main formula.yml for constraints: ${error}`);
    }
  }

  // Collect from each formula under .openpackage/formulas
  const formulasDir = getLocalPackagesDir(cwd);
  if (await exists(formulasDir) && await isDirectory(formulasDir)) {
    try {
      const formulaDirs = await findDirectoriesContainingFile(
        formulasDir,
        FILE_PATTERNS.FORMULA_YML,
        async (filePath) => {
          try {
            return await parsePackageYml(filePath);
          } catch (error) {
            logger.debug(`Failed to parse formula.yml at ${filePath}: ${error}`);
            return null;
          }
        }
      );

      for (const { parsedContent } of formulaDirs) {
        collectFromConfig(parsedContent);
      }
    } catch (error) {
      logger.debug(`Failed to enumerate formulas directory for constraints: ${error}`);
    }
  }

  const result = new Map<string, string[]>();
  for (const [name, ranges] of constraints) {
    result.set(name, Array.from(ranges));
  }

  return result;
}

/**
 * Gather version constraints only from the main .openpackage/formula.yml
 * Used to treat root-declared versions as authoritative overrides
 */
export async function gatherRootVersionConstraints(cwd: string): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();

  const addConstraint = (name?: string, range?: string) => {
    if (!name || !range) return;
    const trimmedName = name.trim();
    const trimmedRange = range.trim();
    if (!trimmedName || !trimmedRange) return;
    if (!result.has(trimmedName)) result.set(trimmedName, []);
    const arr = result.get(trimmedName)!;
    if (!arr.includes(trimmedRange)) arr.push(trimmedRange);
  };

  const mainPackagePath = getLocalPackageYmlPath(cwd);
  if (await exists(mainPackagePath)) {
    try {
      const mainConfig = await parsePackageYml(mainPackagePath);
      mainConfig.formulas?.forEach(dep => addConstraint(dep.name, dep.version));
      mainConfig['dev-formulas']?.forEach(dep => addConstraint(dep.name, dep.version));
    } catch (error) {
      logger.debug(`Failed to parse main formula.yml for root constraints: ${error}`);
    }
  }

  return result;
}

/**
 * Get formula configuration
 */
export async function getGroundzeroPackageConfig(openpackagePath: string, formulaName: string): Promise<PackageYml | null> {
  const formulaPath = await findPackageDirectory(openpackagePath, formulaName);
  if (!formulaPath) {
    return null;
  }
  
  const configPath = await findPackageConfigFile(formulaPath);
  if (!configPath) {
    return null;
  }
  
  try {
    return await parsePackageYml(configPath);
  } catch (error) {
    logger.warn(`Failed to parse formula config for ${formulaName}: ${error}`);
    return null;
  }
}

/**
 * Check for existing installed formula by searching markdown files in ai, .claude, and .cursor directories
 */
export async function checkExistingPackageInMarkdownFiles(
  cwd: string, 
  formulaName: string
): Promise<{ found: boolean; version?: string; location?: string }> {
  // Build search targets: ai directory + all detected platform subdirectories
  const targets: Array<{ dir: string; exts: string[]; label: string }> = [];

  // Always include AI directory
  targets.push({
    dir: join(cwd, PLATFORM_DIRS.AI),
    exts: [FILE_PATTERNS.MD_FILES],
    label: PLATFORM_DIRS.AI
  });

  // Add detected platforms' subdirectories (rules/commands/agents, etc.)
  try {
    const platforms = await getDetectedPlatforms(cwd);
    for (const platform of platforms) {
      const def = getPlatformDefinition(platform as Platform);
      for (const [_, subdirDef] of Object.entries(def.subdirs)) {
        const dirPath = join(cwd, def.rootDir, subdirDef.path);
        targets.push({ dir: dirPath, exts: subdirDef.readExts, label: def.id });
      }
    }
  } catch (error) {
    logger.debug(`Failed to build platform search targets: ${error}`);
  }

  logger.debug(`Checking for existing formula '${formulaName}' across ${targets.length} locations`);

  // Search each target directory for files with supported extensions
  for (const target of targets) {
    try {
      const files = await findFilesByExtension(target.dir, target.exts);
      for (const file of files) {
        // Frontmatter support removed - cannot determine formula ownership
      }
    } catch (dirErr) {
      logger.debug(`Failed to search directory ${target.dir}: ${dirErr}`);
    }
  }

  return { found: false };
}
