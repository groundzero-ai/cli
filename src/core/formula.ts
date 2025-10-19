import { join, relative, dirname } from 'path';
import { Formula, FormulaFile } from '../types/index.js';
import { FILE_PATTERNS } from '../constants/index.js';
import { 
  exists, 
  walkFiles, 
  readTextFile, 
  writeTextFile, 
  remove,
  ensureDir
} from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import {
  FormulaNotFoundError,
  InvalidFormulaError,
} from '../utils/errors.js';
import { validateFormulaName } from '../utils/formula-validation.js';
import { 
  getFormulaPath, 
  getFormulaVersionPath, 
  getLatestFormulaVersion,
  listFormulaVersions
} from './directory.js';
import { parseFormulaYml } from '../utils/formula-yml.js';
import { 
  resolveVersionRange, 
  isExactVersion, 
} from '../utils/version-ranges.js';

/**
 * Formula management operations
 */

export class FormulaManager {
  
  
  /**
   * Load a formula from the registry (latest version by default)
   */
  async loadFormula(formulaName: string, version?: string): Promise<Formula> {
    logger.debug(`Loading formula: ${formulaName}`, { version });
    
    validateFormulaName(formulaName);
    
    let targetVersion: string | null;
    
    if (version) {
      // Check if it's a version range or exact version
      if (isExactVersion(version)) {
        targetVersion = version;
      } else {
        // It's a version range - resolve it to a specific version
        const availableVersions = await listFormulaVersions(formulaName);
        if (availableVersions.length === 0) {
          throw new FormulaNotFoundError(formulaName);
        }
        
        targetVersion = resolveVersionRange(version, availableVersions);
        if (!targetVersion) {
          throw new FormulaNotFoundError(
            `No version of '${formulaName}' satisfies range '${version}'. Available versions: ${availableVersions.join(', ')}`
          );
        }
        logger.debug(`Resolved version range '${version}' to '${targetVersion}' for formula '${formulaName}'`);
      }
    } else {
      // No version specified - get latest
      targetVersion = await getLatestFormulaVersion(formulaName);
    }
    
    if (!targetVersion) {
      throw new FormulaNotFoundError(formulaName);
    }
    
    const formulaPath = getFormulaVersionPath(formulaName, targetVersion);
    if (!(await exists(formulaPath))) {
      throw new FormulaNotFoundError(formulaName);
    }
    
    try {
      // Load formula.yml for metadata
      const formulaYmlPath = join(formulaPath, 'formula.yml');
      if (!(await exists(formulaYmlPath))) {
        throw new FormulaNotFoundError(formulaName);
      }
      
      const metadata = await parseFormulaYml(formulaYmlPath);
      
      // Discover all files in the formula directory
      const files = await this.discoverFormulaFiles(formulaPath);
      
      return { metadata, files };
    } catch (error) {
      if (error instanceof FormulaNotFoundError) {
        throw error;
      }
      logger.error(`Failed to load formula: ${formulaName}`, { error });
      throw new InvalidFormulaError(`Failed to load formula: ${error}`);
    }
  }
  
  /**
   * Save a formula to the registry (versioned)
   */
  async saveFormula(formula: Formula): Promise<void> {
    const { metadata, files } = formula;
    const formulaPath = getFormulaVersionPath(metadata.name, metadata.version);
    
    logger.debug(`Saving formula: ${metadata.name}@${metadata.version}`, { formulaPath });
    
    try {
      // Ensure the version directory exists
      await ensureDir(formulaPath);
      
      // Save files
      for (const file of files) {
        const fullPath = join(formulaPath, file.path);
        await ensureDir(dirname(fullPath));
        await writeTextFile(fullPath, file.content, (file.encoding as BufferEncoding) || 'utf8');
      }
      
      logger.info(`Formula '${metadata.name}@${metadata.version}' saved successfully`);
    } catch (error) {
      logger.error(`Failed to save formula: ${metadata.name}@${metadata.version}`, { error });
      throw new InvalidFormulaError(`Failed to save formula: ${error}`);
    }
  }
  
  /**
   * Delete a specific version of a formula
   */
  async deleteFormulaVersion(formulaName: string, version: string): Promise<void> {
    logger.info(`Deleting formula version: ${formulaName}@${version}`);
    
    validateFormulaName(formulaName);
    
    const formulaPath = getFormulaVersionPath(formulaName, version);
    
    if (!(await exists(formulaPath))) {
      throw new FormulaNotFoundError(`${formulaName}@${version}`);
    }
    
    try {
      await remove(formulaPath);
      logger.info(`Formula version '${formulaName}@${version}' deleted successfully`);
    } catch (error) {
      logger.error(`Failed to delete formula version: ${formulaName}@${version}`, { error });
      throw new InvalidFormulaError(`Failed to delete formula version: ${error}`);
    }
  }
  
  /**
   * Delete all versions of a formula
   */
  async deleteFormula(formulaName: string): Promise<void> {
    logger.info(`Deleting all versions of formula: ${formulaName}`);
    
    validateFormulaName(formulaName);
    
    const formulaPath = getFormulaPath(formulaName);
    
    if (!(await exists(formulaPath))) {
      throw new FormulaNotFoundError(formulaName);
    }
    
    try {
      await remove(formulaPath);
      logger.info(`All versions of formula '${formulaName}' deleted successfully`);
    } catch (error) {
      logger.error(`Failed to delete formula: ${formulaName}`, { error });
      throw new InvalidFormulaError(`Failed to delete formula: ${error}`);
    }
  }
  
  /**
   * Check if a formula exists in the registry (any version)
   */
  async formulaExists(formulaName: string): Promise<boolean> {
    validateFormulaName(formulaName);
    const latestVersion = await getLatestFormulaVersion(formulaName);
    return latestVersion !== null;
  }
  
  /**
   * Discover all files in a formula directory
   */
  private async discoverFormulaFiles(formulaPath: string): Promise<FormulaFile[]> {
    const files: FormulaFile[] = [];
    
    try {
      // Include all file types (no filtering)
      // Get all files recursively in the formula directory
      for await (const fullPath of walkFiles(formulaPath)) {
        const relativePath = relative(formulaPath, fullPath);
        const content = await readTextFile(fullPath);

        files.push({
          path: relativePath,
          content,
          encoding: 'utf8'
        });
      }
      
      logger.debug(`Discovered ${files.length} files in formula directory`, { formulaPath });
      return files;
    } catch (error) {
      logger.error(`Failed to discover files in formula directory: ${formulaPath}`, { error });
      throw new InvalidFormulaError(`Failed to discover formula files: ${error}`);
    }
  }
  
  
}

// Create and export a singleton instance
export const formulaManager = new FormulaManager();
