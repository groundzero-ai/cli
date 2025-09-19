import { join } from 'path';
import { FormulaYml, FormulaDependency } from '../types/index.js';
import { parseFormulaYml } from '../utils/formula-yml.js';
import { exists, isDirectory, listDirectories } from '../utils/fs.js';
import { logger } from '../utils/logger.js';

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
 * Find formula config file (formula.yml or .formula.yml) in a directory
 */
async function findFormulaConfigFile(directoryPath: string): Promise<string | null> {
  const formulaYmlPath = join(directoryPath, 'formula.yml');
  const hiddenFormulaYmlPath = join(directoryPath, '.formula.yml');
  
  if (await exists(hiddenFormulaYmlPath)) {
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
  const groundzeroPath = join(targetDir, 'ai');
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
