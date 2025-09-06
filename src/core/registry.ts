import { join } from 'path';
import * as semver from 'semver';
import { FormulaMetadata, RegistryEntry, SearchResult, CommandResult } from '../types/index.js';
import { 
  listFiles, 
  readJsonFile, 
  exists 
} from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { 
  FormulaNotFoundError, 
  RegistryError 
} from '../utils/errors.js';
import { getRegistryDirectories } from './directory.js';

/**
 * Local registry operations for managing formulas
 */

export class RegistryManager {
  
  /**
   * List all local formulas
   */
  async listFormulas(filter?: string): Promise<RegistryEntry[]> {
    logger.debug('Listing local formulas', { filter });
    
    try {
      const { metadata: metadataDir } = getRegistryDirectories();
      
      if (!(await exists(metadataDir))) {
        logger.debug('Metadata directory does not exist, returning empty list');
        return [];
      }
      
      const metadataFiles = await listFiles(metadataDir);
      const entries: RegistryEntry[] = [];
      
      for (const file of metadataFiles) {
        if (!file.endsWith('.json')) continue;
        
        try {
          const metadataPath = join(metadataDir, file);
          const metadata = await readJsonFile<FormulaMetadata>(metadataPath);
          
          // Apply filter if provided
          if (filter && !this.matchesFilter(metadata.name, filter)) {
            continue;
          }
          
          entries.push({
            name: metadata.name,
            version: metadata.version,
            description: metadata.description,
            author: metadata.author,
            lastUpdated: metadata.updated
          });
        } catch (error) {
          logger.warn(`Failed to read metadata file: ${file}`, { error });
        }
      }
      
      // Sort by name
      entries.sort((a, b) => a.name.localeCompare(b.name));
      
      logger.debug(`Found ${entries.length} formulas`);
      return entries;
    } catch (error) {
      logger.error('Failed to list formulas', { error });
      throw new RegistryError(`Failed to list formulas: ${error}`);
    }
  }
  
  /**
   * Get formula metadata
   */
  async getFormulaMetadata(formulaName: string): Promise<FormulaMetadata> {
    logger.debug(`Getting metadata for formula: ${formulaName}`);
    
    try {
      const { metadata: metadataDir } = getRegistryDirectories();
      const metadataPath = join(metadataDir, `${formulaName}.json`);
      
      if (!(await exists(metadataPath))) {
        throw new FormulaNotFoundError(formulaName);
      }
      
      const metadata = await readJsonFile<FormulaMetadata>(metadataPath);
      return metadata;
    } catch (error) {
      if (error instanceof FormulaNotFoundError) {
        throw error;
      }
      
      logger.error(`Failed to get metadata for formula: ${formulaName}`, { error });
      throw new RegistryError(`Failed to get formula metadata: ${error}`);
    }
  }
  
  /**
   * Search formulas by term
   */
  async searchFormulas(
    term: string, 
    limit: number = 10
  ): Promise<SearchResult> {
    logger.debug(`Searching formulas with term: ${term}`, { limit });
    
    try {
      const allFormulas = await this.listFormulas();
      const searchTerm = term.toLowerCase();
      
      // Simple search implementation - matches name, description, or keywords
      const matchedEntries = allFormulas.filter(entry => {
        const nameMatch = entry.name.toLowerCase().includes(searchTerm);
        const descMatch = entry.description?.toLowerCase().includes(searchTerm);
        
        return nameMatch || descMatch;
      });
      
      // Sort by relevance (name matches first)
      matchedEntries.sort((a, b) => {
        const aNameMatch = a.name.toLowerCase().includes(searchTerm);
        const bNameMatch = b.name.toLowerCase().includes(searchTerm);
        
        if (aNameMatch && !bNameMatch) return -1;
        if (!aNameMatch && bNameMatch) return 1;
        
        return a.name.localeCompare(b.name);
      });
      
      // Apply limit
      const limitedEntries = matchedEntries.slice(0, limit);
      
      return {
        entries: limitedEntries,
        total: matchedEntries.length,
        page: 1,
        limit
      };
    } catch (error) {
      logger.error('Failed to search formulas', { error, term, limit });
      throw new RegistryError(`Failed to search formulas: ${error}`);
    }
  }
  
  /**
   * Check if a formula exists in the local registry
   */
  async hasFormula(formulaName: string): Promise<boolean> {
    try {
      await this.getFormulaMetadata(formulaName);
      return true;
    } catch (error) {
      if (error instanceof FormulaNotFoundError) {
        return false;
      }
      throw error;
    }
  }
  
  /**
   * Get statistics about the local registry
   */
  async getRegistryStats(): Promise<{
    totalFormulas: number;
    totalSize: number;
    lastUpdated?: string;
  }> {
    try {
      const formulas = await this.listFormulas();
      let lastUpdated: string | undefined;
      
      for (const formula of formulas) {
        if (!lastUpdated || formula.lastUpdated > lastUpdated) {
          lastUpdated = formula.lastUpdated;
        }
      }
      
      return {
        totalFormulas: formulas.length,
        totalSize: 0, // TODO: Calculate actual size
        lastUpdated
      };
    } catch (error) {
      logger.error('Failed to get registry stats', { error });
      throw new RegistryError(`Failed to get registry stats: ${error}`);
    }
  }
  
  /**
   * Validate registry integrity
   */
  async validateRegistry(): Promise<CommandResult<{
    valid: boolean;
    issues: string[];
  }>> {
    logger.info('Validating registry integrity');
    
    try {
      const issues: string[] = [];
      const formulas = await this.listFormulas();
      
      for (const formula of formulas) {
        try {
          const metadata = await this.getFormulaMetadata(formula.name);
          
          // Check if all referenced files exist
          const { formulas: formulasDir } = getRegistryDirectories();
          const formulaDir = join(formulasDir, formula.name);
          
          for (const filePath of metadata.files) {
            const fullPath = join(formulaDir, filePath);
            if (!(await exists(fullPath))) {
              issues.push(`Missing file in formula '${formula.name}': ${filePath}`);
            }
          }
          
          // Check metadata consistency
          if (metadata.name !== formula.name) {
            issues.push(`Name mismatch in formula '${formula.name}': metadata says '${metadata.name}'`);
          }
          
          if (semver.neq(metadata.version, formula.version)) {
            issues.push(`Version mismatch in formula '${formula.name}': registry says '${formula.version}', metadata says '${metadata.version}'`);
          }
          
        } catch (error) {
          issues.push(`Failed to validate formula '${formula.name}': ${error}`);
        }
      }
      
      const valid = issues.length === 0;
      logger.info(`Registry validation complete`, { valid, issueCount: issues.length });
      
      return {
        success: true,
        data: { valid, issues }
      };
    } catch (error) {
      logger.error('Failed to validate registry', { error });
      return {
        success: false,
        error: `Failed to validate registry: ${error}`
      };
    }
  }
  
  /**
   * Simple pattern matching for filtering
   */
  private matchesFilter(name: string, filter: string): boolean {
    // Convert simple glob pattern to regex
    const pattern = filter
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')
      .toLowerCase();
    
    const regex = new RegExp(`^${pattern}$`);
    return regex.test(name.toLowerCase());
  }
}

// Create and export a singleton instance
export const registryManager = new RegistryManager();
