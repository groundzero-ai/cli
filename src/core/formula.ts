import { join, relative, basename } from 'path';
import { Formula, FormulaMetadata, FormulaFile, TemplateVariable } from '../types/index.js';
import { 
  exists, 
  walkFiles, 
  readTextFile, 
  writeTextFile, 
  writeJsonFile, 
  readJsonFile, 
  copyFile, 
  remove,
  isDirectory 
} from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { 
  FormulaNotFoundError, 
  FormulaAlreadyExistsError, 
  InvalidFormulaError,
  ValidationError 
} from '../utils/errors.js';
import { getFormulaPath, getFormulaMetadataPath } from './directory.js';

/**
 * Formula management operations
 */

export class FormulaManager {
  
  
  /**
   * Load a formula from the registry
   */
  async loadFormula(formulaName: string): Promise<Formula> {
    logger.debug(`Loading formula: ${formulaName}`);
    
    this.validateFormulaName(formulaName);
    
    const metadataPath = getFormulaMetadataPath(formulaName);
    if (!(await exists(metadataPath))) {
      throw new FormulaNotFoundError(formulaName);
    }
    
    try {
      const metadata = await readJsonFile<FormulaMetadata>(metadataPath);
      const formulaPath = getFormulaPath(formulaName);
      const files: FormulaFile[] = [];
      
      // Load all files
      for (const filePath of metadata.files) {
        const fullPath = join(formulaPath, filePath);
        if (await exists(fullPath)) {
          const content = await readTextFile(fullPath);
          const isTemplate = this.detectTemplateFile(content);
          
          files.push({
            path: filePath,
            content,
            isTemplate,
            encoding: 'utf8'
          });
        } else {
          logger.warn(`Formula file missing: ${filePath}`, { formulaName, filePath });
        }
      }
      
      return { metadata, files };
    } catch (error) {
      logger.error(`Failed to load formula: ${formulaName}`, { error });
      throw new InvalidFormulaError(`Failed to load formula: ${error}`);
    }
  }
  
  /**
   * Save a formula to the registry
   */
  async saveFormula(formula: Formula): Promise<void> {
    const { metadata, files } = formula;
    const formulaPath = getFormulaPath(metadata.name);
    const metadataPath = getFormulaMetadataPath(metadata.name);
    
    logger.debug(`Saving formula: ${metadata.name}`, { formulaPath, metadataPath });
    
    try {
      // Save metadata
      await writeJsonFile(metadataPath, metadata);
      
      // Save files
      for (const file of files) {
        const fullPath = join(formulaPath, file.path);
        await writeTextFile(fullPath, file.content, (file.encoding as BufferEncoding) || 'utf8');
      }
      
      logger.info(`Formula '${metadata.name}' saved successfully`);
    } catch (error) {
      logger.error(`Failed to save formula: ${metadata.name}`, { error });
      throw new InvalidFormulaError(`Failed to save formula: ${error}`);
    }
  }
  
  /**
   * Delete a formula from the registry
   */
  async deleteFormula(formulaName: string): Promise<void> {
    logger.info(`Deleting formula: ${formulaName}`);
    
    this.validateFormulaName(formulaName);
    
    const formulaPath = getFormulaPath(formulaName);
    const metadataPath = getFormulaMetadataPath(formulaName);
    
    if (!(await exists(metadataPath))) {
      throw new FormulaNotFoundError(formulaName);
    }
    
    try {
      await remove(formulaPath);
      await remove(metadataPath);
      logger.info(`Formula '${formulaName}' deleted successfully`);
    } catch (error) {
      logger.error(`Failed to delete formula: ${formulaName}`, { error });
      throw new InvalidFormulaError(`Failed to delete formula: ${error}`);
    }
  }
  
  /**
   * Check if a formula exists in the registry
   */
  async formulaExists(formulaName: string): Promise<boolean> {
    this.validateFormulaName(formulaName);
    const metadataPath = getFormulaMetadataPath(formulaName);
    return await exists(metadataPath);
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
