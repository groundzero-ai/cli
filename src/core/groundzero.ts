import { join } from 'path';
import { FormulaYml, FormulaDependency } from '../types/index.js';
import { parseFormulaYml } from '../utils/formula-yml.js';
import { exists, isDirectory, listDirectories, readTextFile } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { FILE_PATTERNS, PLATFORM_DIRS } from '../constants/index.js';
import { getLocalFormulaYmlPath, getLocalFormulasDir } from '../utils/paths.js';
import { parseMarkdownFrontmatter } from '../utils/md-frontmatter.js';
import { findFilesByExtension } from '../utils/file-discovery.js';
import { getDetectedPlatforms, getPlatformDefinition, type Platform } from './platforms.js';

/**
 * Formula metadata from groundzero directory
 */
export interface GroundzeroFormula {
  name: string;
  version: string;
  description?: string;
  formulas?: FormulaDependency[];
  'dev-formulas'?: FormulaDependency[];
  path: string;
}

/**
 * Find formula config file (.groundzero/formula.yml or formula.yml) in a directory
 */
async function findFormulaConfigFile(directoryPath: string): Promise<string | null> {
  const groundzeroFormulaYmlPath = getLocalFormulaYmlPath(directoryPath);
  const formulaYmlPath = join(directoryPath, FILE_PATTERNS.FORMULA_YML);
  
  if (await exists(groundzeroFormulaYmlPath)) {
    return groundzeroFormulaYmlPath;
  } else if (await exists(formulaYmlPath)) {
    return formulaYmlPath;
  }
  
  return null;
}

/**
 * Get the version of an installed formula by formula name
 */
export async function getInstalledFormulaVersion(formulaName: string, targetDir: string): Promise<string | null> {
  const groundzeroPath = join(targetDir, PLATFORM_DIRS.AI);
  const formulaGroundzeroPath = join(groundzeroPath, formulaName);
  
  if (!(await exists(formulaGroundzeroPath))) {
    return null;
  }
  
  const configPath = await findFormulaConfigFile(formulaGroundzeroPath);
  if (!configPath) {
    return null;
  }
  
  try {
    const config = await parseFormulaYml(configPath);
    return config.version;
  } catch (error) {
    logger.warn(`Failed to parse formula config for ${formulaName}: ${error}`);
    return null;
  }
}

/**
 * Find formula directory in ai by matching formula name
 */
export async function findFormulaDirectory(groundzeroPath: string, formulaName: string): Promise<string | null> {
  if (!(await exists(groundzeroPath)) || !(await isDirectory(groundzeroPath))) {
    return null;
  }

  try {
    const subdirectories = await listDirectories(groundzeroPath);
    
    for (const subdir of subdirectories) {
      const subdirPath = join(groundzeroPath, subdir);
      const configPath = await findFormulaConfigFile(subdirPath);
      
      if (configPath) {
        try {
          const formulaConfig = await parseFormulaYml(configPath);
          if (formulaConfig.name === formulaName) {
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
 * Scan ai directory for all available formulas
 */
export async function scanGroundzeroFormulas(groundzeroPath: string): Promise<Map<string, GroundzeroFormula>> {
  const formulas = new Map<string, GroundzeroFormula>();
  
  if (!(await exists(groundzeroPath)) || !(await isDirectory(groundzeroPath))) {
    logger.debug('AI directory not found or not a directory', { groundzeroPath });
    return formulas;
  }

  try {
    const subdirectories = await listDirectories(groundzeroPath);
    
    for (const subdir of subdirectories) {
      const subdirPath = join(groundzeroPath, subdir);
      const configPath = await findFormulaConfigFile(subdirPath);
      
      if (configPath) {
        try {
          const formulaConfig = await parseFormulaYml(configPath);
          formulas.set(formulaConfig.name, {
            name: formulaConfig.name,
            version: formulaConfig.version,
            description: formulaConfig.description,
            formulas: formulaConfig.formulas || [],
            'dev-formulas': formulaConfig['dev-formulas'] || [],
            path: subdirPath
          });
        } catch (error) {
          logger.warn(`Failed to parse formula file ${configPath}: ${error}`);
        }
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

  const collectFromConfig = (config: FormulaYml | null | undefined) => {
    if (!config) {
      return;
    }

    config.formulas?.forEach(dep => addConstraint(dep.name, dep.version));
    config['dev-formulas']?.forEach(dep => addConstraint(dep.name, dep.version));
  };

  // Collect from main .groundzero/formula.yml if present
  const mainFormulaPath = getLocalFormulaYmlPath(cwd);
  if (await exists(mainFormulaPath)) {
    try {
      const mainConfig = await parseFormulaYml(mainFormulaPath);
      collectFromConfig(mainConfig);
    } catch (error) {
      logger.debug(`Failed to parse main formula.yml for constraints: ${error}`);
    }
  }

  // Collect from each formula under .groundzero/formulas
  const formulasDir = getLocalFormulasDir(cwd);
  if (await exists(formulasDir) && await isDirectory(formulasDir)) {
    try {
      const subdirs = await listDirectories(formulasDir);
      for (const subdir of subdirs) {
        const configPath = join(formulasDir, subdir, FILE_PATTERNS.FORMULA_YML);
        if (!(await exists(configPath))) {
          continue;
        }

        try {
          const subConfig = await parseFormulaYml(configPath);
          collectFromConfig(subConfig);
        } catch (error) {
          logger.debug(`Failed to parse formula.yml for ${subdir}: ${error}`);
        }
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
 * Gather version constraints only from the main .groundzero/formula.yml
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

  const mainFormulaPath = getLocalFormulaYmlPath(cwd);
  if (await exists(mainFormulaPath)) {
    try {
      const mainConfig = await parseFormulaYml(mainFormulaPath);
      mainConfig.formulas?.forEach(dep => addConstraint(dep.name, dep.version));
      mainConfig['dev-formulas']?.forEach(dep => addConstraint(dep.name, dep.version));
    } catch (error) {
      logger.debug(`Failed to parse main formula.yml for root constraints: ${error}`);
    }
  }

  return result;
}

/**
 * Get formula configuration from ai directory
 */
export async function getGroundzeroFormulaConfig(groundzeroPath: string, formulaName: string): Promise<FormulaYml | null> {
  const formulaPath = await findFormulaDirectory(groundzeroPath, formulaName);
  if (!formulaPath) {
    return null;
  }
  
  const configPath = await findFormulaConfigFile(formulaPath);
  if (!configPath) {
    return null;
  }
  
  try {
    return await parseFormulaYml(configPath);
  } catch (error) {
    logger.warn(`Failed to parse formula config for ${formulaName}: ${error}`);
    return null;
  }
}

/**
 * Check for existing installed formula by searching markdown files in ai, .claude, and .cursor directories
 */
export async function checkExistingFormulaInMarkdownFiles(
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
      for (const ext of target.exts) {
        const files = await findFilesByExtension(target.dir, ext, target.dir);
        for (const file of files) {
          try {
            const content = await readTextFile(file.fullPath);
            const frontmatter: any = parseMarkdownFrontmatter(content);
            if (frontmatter?.formula?.name === formulaName) {
              const version: string | undefined = (typeof frontmatter.version === 'string' ? frontmatter.version : undefined)
                || (typeof frontmatter.formula?.version === 'string' ? frontmatter.formula.version : undefined);
              logger.debug(`Found existing formula '${formulaName}' in ${file.fullPath}`, { version });
              return { found: true, version, location: file.fullPath };
            }
          } catch (readErr) {
            logger.debug(`Failed to read or parse ${file.fullPath}: ${readErr}`);
          }
        }
      }
    } catch (dirErr) {
      logger.debug(`Failed to search directory ${target.dir}: ${dirErr}`);
    }
  }

  return { found: false };
}
