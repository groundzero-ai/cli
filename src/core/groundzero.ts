import { join } from 'path';
import * as semver from 'semver';
import { FormulaYml, FormulaDependency } from '../types/index.js';
import { parseFormulaYml } from '../utils/formula-yml.js';
import { exists, isDirectory, listDirectories, walkFiles, readTextFile } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { FILE_PATTERNS, PLATFORM_DIRS } from '../constants/index.js';
import { getLocalFormulaYmlPath, getLocalFormulasDir } from '../utils/paths.js';
import { listFormulaVersions } from './directory.js';

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
 * Find formula config file (.groundzero/formula.yml, formula.yml, or .formula.yml) in a directory
 */
async function findFormulaConfigFile(directoryPath: string): Promise<string | null> {
  const groundzeroFormulaYmlPath = getLocalFormulaYmlPath(directoryPath);
  const formulaYmlPath = join(directoryPath, FILE_PATTERNS.FORMULA_YML);
  const hiddenFormulaYmlPath = join(directoryPath, FILE_PATTERNS.HIDDEN_FORMULA_YML);
  
  if (await exists(groundzeroFormulaYmlPath)) {
    return groundzeroFormulaYmlPath;
  } else if (await exists(hiddenFormulaYmlPath)) {
    return hiddenFormulaYmlPath;
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

    // Highest precedence: resolutions pins (optional)
    if (includeResolutions && config.resolutions) {
      for (const [depName, pinnedVersion] of Object.entries(config.resolutions)) {
        addConstraint(depName, pinnedVersion);
      }
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
 * Read and write helpers for resolutions in main formula.yml
 */
export async function readResolutions(cwd: string): Promise<Record<string, string>> {
  const mainFormulaPath = getLocalFormulaYmlPath(cwd);
  if (!(await exists(mainFormulaPath))) {
    return {};
  }
  try {
    const config = await parseFormulaYml(mainFormulaPath);
    return config.resolutions || {};
  } catch {
    return {};
  }
}

export async function writeResolutions(
  cwd: string,
  updater: (current: Record<string, string>) => Record<string, string>
): Promise<void> {
  const mainFormulaPath = getLocalFormulaYmlPath(cwd);
  const config = (await exists(mainFormulaPath)) ? await parseFormulaYml(mainFormulaPath) : {
    name: 'project',
    version: '0.1.0'
  } as FormulaYml;
  const current = config.resolutions || {};
  const next = updater(current);
  config.resolutions = next;
  await (await import('../utils/formula-yml.js')).writeFormulaYml(mainFormulaPath, config);
}

/**
 * Remove resolution pins that are no longer necessary (constraints intersect without the pin)
 */
export async function cleanupObsoleteResolutions(cwd: string): Promise<{ removed: string[] }> {
  const mainFormulaPath = getLocalFormulaYmlPath(cwd);
  if (!(await exists(mainFormulaPath))) {
    return { removed: [] };
  }

  const config = await parseFormulaYml(mainFormulaPath);
  const resolutions = { ...(config.resolutions || {}) };
  const removed: string[] = [];

  if (Object.keys(resolutions).length === 0) {
    return { removed: [] };
  }

  // Gather constraints without resolutions (to see if conflict still exists)
  const constraintsNoPins = await gatherGlobalVersionConstraints(cwd, false);

  for (const [depName, pinned] of Object.entries(resolutions)) {
    try {
      const available = await listFormulaVersions(depName);
      if (available.length === 0) {
        continue;
      }

      const ranges = constraintsNoPins.get(depName) || [];
      if (ranges.length === 0) {
        // No constraints apart from pin → pin is unnecessary
        delete resolutions[depName];
        removed.push(depName);
        continue;
      }

      const satisfying = available.filter(v => ranges.every(r => {
        try { return semver.satisfies(v, r); } catch { return false; }
      }));

      if (satisfying.length > 0) {
        // Constraints now compatible without pin → remove pin
        delete resolutions[depName];
        removed.push(depName);
      }
    } catch (e) {
      logger.debug(`Skipping cleanup check for ${depName}: ${e}`);
    }
  }

  if (removed.length > 0) {
    config.resolutions = resolutions;
    await (await import('../utils/formula-yml.js')).writeFormulaYml(mainFormulaPath, config);
    logger.info(`Cleaned up obsolete resolutions: ${removed.join(', ')}`);
  }

  return { removed };
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
  const searchDirectories = [
    join(cwd, PLATFORM_DIRS.AI),
    join(cwd, PLATFORM_DIRS.CLAUDECODE),
    join(cwd, PLATFORM_DIRS.CURSOR)
  ];

  logger.debug(`Checking for existing formula '${formulaName}' in directories: ${searchDirectories.join(', ')}`);

  for (const searchDir of searchDirectories) {
    logger.debug(`Checking directory: ${searchDir}`);
    if (!(await exists(searchDir)) || !(await isDirectory(searchDir))) {
      logger.debug(`Directory does not exist or is not a directory: ${searchDir}`);
      continue;
    }

    try {
      // Walk through all files in the directory and filter for markdown files
      for await (const filePath of walkFiles(searchDir)) {
        // Filter for markdown files
        if (!filePath.endsWith('.md') && !filePath.endsWith('.mdc')) {
          continue;
        }
        
        logger.debug(`Checking markdown file: ${filePath}`);
        try {
          const content = await readTextFile(filePath);
          
          // Check for frontmatter with formula name
          const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
          if (frontmatterMatch) {
            const frontmatter = frontmatterMatch[1];
            
            // Look for formula name in frontmatter - support both formats:
            // 1. formula: formula-name (direct format)
            // 2. formula:\n  name: formula-name (nested format)
            let foundFormulaName: string | null = null;
            
            // Parse frontmatter line by line to handle both formats
            const lines = frontmatter.split('\n');
            let formulaLineIndex = -1;
            
            // Find the formula line
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].trim().startsWith('formula:')) {
                formulaLineIndex = i;
                break;
              }
            }
            
            if (formulaLineIndex >= 0) {
              const formulaLine = lines[formulaLineIndex];
              const afterFormula = formulaLine.substring(formulaLine.indexOf(':') + 1).trim();
              
              // If there's content on the same line, it's direct format
              if (afterFormula) {
                foundFormulaName = afterFormula;
                logger.debug(`Direct format match: '${foundFormulaName}'`);
              } else {
                // Check for nested format on the next line
                if (formulaLineIndex + 1 < lines.length) {
                  const nextLine = lines[formulaLineIndex + 1].trim();
                  const nameMatch = nextLine.match(/^name:\s*(.+)$/);
                  if (nameMatch) {
                    foundFormulaName = nameMatch[1].trim();
                    logger.debug(`Nested format match: '${foundFormulaName}'`);
                  } else {
                    logger.debug(`No nested name found after formula line`);
                  }
                } else {
                  logger.debug(`No line after formula line`);
                }
              }
            } else {
              logger.debug(`No formula line found in frontmatter`);
            }
            
            logger.debug(`Found formula name in frontmatter: '${foundFormulaName}', looking for: '${formulaName}'`);
            if (foundFormulaName && foundFormulaName === formulaName) {
              // Extract version if present - support both direct and nested formats
              let version: string | undefined;
              const directVersionMatch = frontmatter.match(/^version:\s*(.+)$/m);
              if (directVersionMatch) {
                version = directVersionMatch[1].trim();
              } else {
                const nestedVersionMatch = frontmatter.match(/^formula:\s*\n[\s\S]*?\n\s*version:\s*(.+)$/m);
                if (nestedVersionMatch) {
                  version = nestedVersionMatch[1].trim();
                }
              }
              
              logger.debug(`Found existing formula '${formulaName}' in ${filePath}`, { version });
              return {
                found: true,
                version,
                location: filePath
              };
            }
          }
        } catch (error) {
          logger.debug(`Failed to read file ${filePath}: ${error}`);
          // Continue to next file
        }
      }
    } catch (error) {
      logger.debug(`Failed to walk directory ${searchDir}: ${error}`);
      // Continue to next directory
    }
  }

  return { found: false };
}
