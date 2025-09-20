import { join, relative, basename, dirname } from 'path';
import { Formula, FormulaYml, FormulaFile, TemplateVariable } from '../types/index.js';
import { 
  exists, 
  walkFiles, 
  readTextFile, 
  writeTextFile, 
  copyFile, 
  remove,
  isDirectory,
  ensureDir
} from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { 
  FormulaNotFoundError, 
  FormulaAlreadyExistsError, 
  InvalidFormulaError,
  ValidationError 
} from '../utils/errors.js';
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
  isWildcardVersion 
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
    
    this.validateFormulaName(formulaName);
    
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
    
    this.validateFormulaName(formulaName);
    
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
    
    this.validateFormulaName(formulaName);
    
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
    this.validateFormulaName(formulaName);
    const latestVersion = await getLatestFormulaVersion(formulaName);
    return latestVersion !== null;
  }
  
  /**
   * Discover all files in a formula directory
   */
  private async discoverFormulaFiles(formulaPath: string): Promise<FormulaFile[]> {
    const files: FormulaFile[] = [];
    
    try {
      // Get default exclude patterns to filter out system files
      const excludePatterns = this.getDefaultExcludePatterns();
      
      // Get all files recursively in the formula directory
      for await (const fullPath of walkFiles(formulaPath, excludePatterns)) {
        const relativePath = relative(formulaPath, fullPath);
        const content = await readTextFile(fullPath);
        const isTemplate = this.detectTemplateFile(content);
        
        files.push({
          path: relativePath,
          content,
          isTemplate,
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

  /**
   * Apply template variables to a formula's content
   */
  applyTemplateVariables(content: string, variables: Record<string, any>): string {
    let result = content;
    
    // Simple template variable replacement ({{variable}})
    // In a production system, you might want to use a more sophisticated template engine
    for (const [key, value] of Object.entries(variables)) {
      const pattern = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g');
      result = result.replace(pattern, String(value));
    }
    
    return result;
  }
  
  /**
   * Extract template variables from formula files
   */
  private extractTemplateVariables(files: FormulaFile[]): TemplateVariable[] {
    const variables = new Set<string>();
    
    for (const file of files) {
      if (file.isTemplate) {
        // Extract {{variable}} patterns
        const matches = file.content.match(/\{\{\s*(\w+)\s*\}\}/g);
        if (matches) {
          for (const match of matches) {
            const variable = match.replace(/\{\{\s*|\s*\}\}/g, '');
            variables.add(variable);
          }
        }
      }
    }
    
    // Convert to TemplateVariable objects with defaults
    return Array.from(variables).map(name => ({
      name,
      type: 'string' as const,
      required: true,
      description: `Template variable: ${name}`
    }));
  }
  
  /**
   * Detect if a file contains template variables
   */
  private detectTemplateFile(content: string): boolean {
    return /\{\{\s*\w+\s*\}\}/.test(content);
  }
  
  /**
   * Get default exclude patterns
   */
  private getDefaultExcludePatterns(): string[] {
    return [
      'node_modules',
      '.git',
      '.svn',
      '.hg',
      '.DS_Store',
      'Thumbs.db',
      '*.log',
      '.env',
      '.env.*',
      'dist',
      'build',
      'coverage',
      '.nyc_output',
      '*.tmp',
      '*.temp'
    ];
  }
  
  /**
   * Validate formula name
   */
  private validateFormulaName(name: string): void {
    if (!name || typeof name !== 'string') {
      throw new ValidationError('Formula name is required');
    }
    
    if (name.length < 1 || name.length > 100) {
      throw new ValidationError('Formula name must be between 1 and 100 characters');
    }
    
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      throw new ValidationError('Formula name can only contain letters, numbers, hyphens, and underscores');
    }
    
    if (name.startsWith('-') || name.endsWith('-')) {
      throw new ValidationError('Formula name cannot start or end with a hyphen');
    }
  }
}

// Create and export a singleton instance
export const formulaManager = new FormulaManager();
