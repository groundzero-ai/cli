import { join } from 'path';
import * as semver from 'semver';
import { FormulaYml, RegistryEntry, CommandResult } from '../types/index.js';
import { 
  listDirectories, 
  exists 
} from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { 
  FormulaNotFoundError, 
  RegistryError 
} from '../utils/errors.js';
import {
  getRegistryDirectories,
  getFormulaVersionPath,
  getLatestFormulaVersion,
  listFormulaVersions,
  hasFormulaVersion,
  findFormulaByName,
  listAllFormulas
} from './directory.js';
import { parseFormulaYml } from '../utils/formula-yml.js';
import { 
  resolveVersionRange, 
  isExactVersion, 
} from '../utils/version-ranges.js';

/**
 * Local registry operations for managing formulas
 */

export class RegistryManager {
  
  /**
   * List local formulas (latest version by default, all versions with --all)
   */
  async listFormulas(filter?: string, showAllVersions: boolean = false): Promise<RegistryEntry[]> {
    logger.debug('Listing local formulas', { filter, showAllVersions });
    
    try {
      const { formulas: formulasDir } = getRegistryDirectories();
      
      if (!(await exists(formulasDir))) {
        logger.debug('Formulas directory does not exist, returning empty list');
        return [];
      }
      
      const formulaNames = await listAllFormulas();
      const entries: RegistryEntry[] = [];
      
      for (const formulaName of formulaNames) {
        try {
          if (showAllVersions) {
            // Get all versions for this formula
            const versions = await listFormulaVersions(formulaName);
            if (versions.length === 0) continue;
            
            // Process each version
            for (const version of versions) {
              const formulaPath = getFormulaVersionPath(formulaName, version);
              const formulaYmlPath = join(formulaPath, 'formula.yml');
              const metadata = await parseFormulaYml(formulaYmlPath);
              
              // Apply filter if provided
              if (filter && !this.matchesFilter(metadata.name, filter)) {
                continue;
              }
              
              entries.push({
                name: metadata.name,
                version: metadata.version,
                description: metadata.description,
                author: undefined, // Not available in formula.yml
                lastUpdated: new Date().toISOString() // We don't track this anymore
              });
            }
          } else {
            // Show only latest version
            const latestVersion = await getLatestFormulaVersion(formulaName);
            if (!latestVersion) continue;
            
            const formulaPath = getFormulaVersionPath(formulaName, latestVersion);
            const formulaYmlPath = join(formulaPath, 'formula.yml');
            const metadata = await parseFormulaYml(formulaYmlPath);
            
            // Apply filter if provided
            if (filter && !this.matchesFilter(metadata.name, filter)) {
              continue;
            }
            
            entries.push({
              name: metadata.name,
              version: metadata.version,
              description: metadata.description,
              author: undefined, // Not available in formula.yml
              lastUpdated: new Date().toISOString() // We don't track this anymore
            });
          }
        } catch (error) {
          logger.warn(`Failed to read formula: ${formulaName}`, { 
            error: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined
          });
        }
      }
      
      // Sort by name first, then by version (highest first) if showing all versions
      if (showAllVersions) {
        entries.sort((a, b) => {
          const nameCompare = a.name.localeCompare(b.name);
          if (nameCompare !== 0) return nameCompare;
          return semver.compare(b.version, a.version); // Higher versions first
        });
      } else {
        // Sort by name only when showing latest versions
        entries.sort((a, b) => a.name.localeCompare(b.name));
      }
      
      logger.debug(`Found ${entries.length} formula${showAllVersions ? ' versions' : 's'}`);
      return entries;
    } catch (error) {
      logger.error('Failed to list formulas', { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw new RegistryError(`Failed to list formulas: ${error}`);
    }
  }
  
  /**
   * Get formula metadata (latest version by default)
   */
  async getFormulaMetadata(formulaName: string, version?: string): Promise<FormulaYml> {
    logger.debug(`Getting metadata for formula: ${formulaName}`, { version });

    try {
      // Find the actual formula name (handles case-insensitive lookup)
      const actualFormulaName = await findFormulaByName(formulaName);
      if (!actualFormulaName) {
        throw new FormulaNotFoundError(formulaName);
      }

      let targetVersion: string | null;

      if (version) {
        // Check if it's a version range or exact version
        if (isExactVersion(version)) {
          targetVersion = version;
        } else {
          // It's a version range - resolve it to a specific version
          const availableVersions = await listFormulaVersions(actualFormulaName);
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
        targetVersion = await getLatestFormulaVersion(actualFormulaName);
      }

      if (!targetVersion) {
        throw new FormulaNotFoundError(formulaName);
      }

      const formulaPath = getFormulaVersionPath(actualFormulaName, targetVersion);
      const formulaYmlPath = join(formulaPath, 'formula.yml');

      if (!(await exists(formulaYmlPath))) {
        throw new FormulaNotFoundError(formulaName);
      }

      const metadata = await parseFormulaYml(formulaYmlPath);
      return metadata;
    } catch (error) {
      if (error instanceof FormulaNotFoundError) {
        throw error;
      }
      
      logger.error(`Failed to get metadata for formula: ${formulaName}`, { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw new RegistryError(`Failed to get formula metadata: ${error}`);
    }
  }

  /**
   * List all versions of a formula
   */
  async listFormulaVersions(formulaName: string): Promise<string[]> {
    return await listFormulaVersions(formulaName);
  }
  
  /**
   * Get specific version metadata
   */
  async getFormulaVersion(formulaName: string, version: string): Promise<FormulaYml> {
    return await this.getFormulaMetadata(formulaName, version);
  }
  
  /**
   * Check if a formula exists (any version)
   */
  async hasFormula(formulaName: string): Promise<boolean> {
    // First try direct lookup (works for normalized names)
    const latestVersion = await getLatestFormulaVersion(formulaName);
    if (latestVersion !== null) {
      return true;
    }

    // If not found, try case-insensitive lookup
    const foundFormula = await findFormulaByName(formulaName);
    return foundFormula !== null;
  }
  
  /**
   * Check if a specific version exists
   */
  async hasFormulaVersion(formulaName: string, version: string): Promise<boolean> {
    return await hasFormulaVersion(formulaName, version);
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
      logger.error('Failed to get registry stats', { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
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
          
          // Check metadata consistency
          if (metadata.name !== formula.name) {
            issues.push(`Name mismatch in formula '${formula.name}': formula.yml says '${metadata.name}'`);
          }
          
          if (semver.neq(metadata.version, formula.version)) {
            issues.push(`Version mismatch in formula '${formula.name}': registry says '${formula.version}', formula.yml says '${metadata.version}'`);
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
      logger.error('Failed to validate registry', { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
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
    
    // If pattern contains wildcards, use exact match, otherwise use substring match
    if (pattern.includes('*') || pattern.includes('.')) {
      const regex = new RegExp(`^${pattern}$`);
      return regex.test(name.toLowerCase());
    } else {
      return name.toLowerCase().includes(pattern);
    }
  }
}

// Create and export a singleton instance
export const registryManager = new RegistryManager();
