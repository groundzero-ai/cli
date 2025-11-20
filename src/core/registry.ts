import { join } from 'path';
import * as semver from 'semver';
import { PackageYml, RegistryEntry, CommandResult } from '../types/index.js';
import { 
  listDirectories, 
  exists 
} from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { 
  PackageNotFoundError, 
  RegistryError 
} from '../utils/errors.js';
import {
  getRegistryDirectories,
  getPackageVersionPath,
  getLatestPackageVersion,
  listPackageVersions,
  hasPackageVersion,
  findPackageByName,
  listAllPackages
} from './directory.js';
import { parsePackageYml } from '../utils/package-yml.js';
import { 
  resolveVersionRange, 
  isExactVersion, 
} from '../utils/version-ranges.js';

/**
 * Local registry operations for managing packages
 */

export class RegistryManager {
  
  /**
   * List local packages (latest version by default, all versions with --all)
   */
  async listPackages(filter?: string, showAllVersions: boolean = false): Promise<RegistryEntry[]> {
    logger.debug('Listing local packages', { filter, showAllVersions });
    
    try {
      const { packages: packagesDir } = getRegistryDirectories();
      
      if (!(await exists(packagesDir))) {
        logger.debug('Packages directory does not exist, returning empty list');
        return [];
      }
      
      const packageNames = await listAllPackages();
      const entries: RegistryEntry[] = [];
      
      for (const packageName of packageNames) {
        try {
          if (showAllVersions) {
            // Get all versions for this package
            const versions = await listPackageVersions(packageName);
            if (versions.length === 0) continue;
            
            // Process each version
            for (const version of versions) {
              const packagePath = getPackageVersionPath(packageName, version);
              const packageYmlPath = join(packagePath, 'package.yml');
              const metadata = await parsePackageYml(packageYmlPath);
              
              // Apply filter if provided
              if (filter && !this.matchesFilter(metadata.name, filter)) {
                continue;
              }
              
              entries.push({
                name: metadata.name,
                version: metadata.version,
                description: metadata.description,
                author: undefined, // Not available in package.yml
                lastUpdated: new Date().toISOString() // We don't track this anymore
              });
            }
          } else {
            // Show only latest version
            const latestVersion = await getLatestPackageVersion(packageName);
            if (!latestVersion) continue;
            
            const packagePath = getPackageVersionPath(packageName, latestVersion);
            const packageYmlPath = join(packagePath, 'package.yml');
            const metadata = await parsePackageYml(packageYmlPath);
            
            // Apply filter if provided
            if (filter && !this.matchesFilter(metadata.name, filter)) {
              continue;
            }
            
            entries.push({
              name: metadata.name,
              version: metadata.version,
              description: metadata.description,
              author: undefined, // Not available in package.yml
              lastUpdated: new Date().toISOString() // We don't track this anymore
            });
          }
        } catch (error) {
          logger.warn(`Failed to read package: ${packageName}`, { 
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
      
      logger.debug(`Found ${entries.length} package${showAllVersions ? ' versions' : 's'}`);
      return entries;
    } catch (error) {
      logger.error('Failed to list packages', { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw new RegistryError(`Failed to list packages: ${error}`);
    }
  }
  
  /**
   * Get package metadata (latest version by default)
   */
  async getPackageMetadata(packageName: string, version?: string): Promise<PackageYml> {
    logger.debug(`Getting metadata for package: ${packageName}`, { version });

    try {
      // Find the actual package name (handles case-insensitive lookup)
      const actualPackageName = await findPackageByName(packageName);
      if (!actualPackageName) {
        throw new PackageNotFoundError(packageName);
      }

      let targetVersion: string | null;

      if (version) {
        // Check if it's a version range or exact version
        if (isExactVersion(version)) {
          targetVersion = version;
        } else {
          // It's a version range - resolve it to a specific version
          const availableVersions = await listPackageVersions(actualPackageName);
          if (availableVersions.length === 0) {
            throw new PackageNotFoundError(packageName);
          }

          targetVersion = resolveVersionRange(version, availableVersions);
          if (!targetVersion) {
            throw new PackageNotFoundError(
              `No version of '${packageName}' satisfies range '${version}'. Available versions: ${availableVersions.join(', ')}`
            );
          }
          logger.debug(`Resolved version range '${version}' to '${targetVersion}' for package '${packageName}'`);
        }
      } else {
        // No version specified - get latest
        targetVersion = await getLatestPackageVersion(actualPackageName);
      }

      if (!targetVersion) {
        throw new PackageNotFoundError(packageName);
      }

      const packagePath = getPackageVersionPath(actualPackageName, targetVersion);
      const packageYmlPath = join(packagePath, 'package.yml');

      if (!(await exists(packageYmlPath))) {
        throw new PackageNotFoundError(packageName);
      }

      const metadata = await parsePackageYml(packageYmlPath);
      return metadata;
    } catch (error) {
      if (error instanceof PackageNotFoundError) {
        throw error;
      }
      
      logger.error(`Failed to get metadata for package: ${packageName}`, { 
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });
      throw new RegistryError(`Failed to get package metadata: ${error}`);
    }
  }

  /**
   * List all versions of a package
   */
  async listPackageVersions(packageName: string): Promise<string[]> {
    return await listPackageVersions(packageName);
  }
  
  /**
   * Get specific version metadata
   */
  async getPackageVersion(packageName: string, version: string): Promise<PackageYml> {
    return await this.getPackageMetadata(packageName, version);
  }
  
  /**
   * Check if a package exists (any version)
   */
  async hasPackage(packageName: string): Promise<boolean> {
    // First try direct lookup (works for normalized names)
    const latestVersion = await getLatestPackageVersion(packageName);
    if (latestVersion !== null) {
      return true;
    }

    // If not found, try case-insensitive lookup
    const foundPackage = await findPackageByName(packageName);
    return foundPackage !== null;
  }
  
  /**
   * Check if a specific version exists
   */
  async hasPackageVersion(packageName: string, version: string): Promise<boolean> {
    return await hasPackageVersion(packageName, version);
  }
  
  /**
   * Get statistics about the local registry
   */
  async getRegistryStats(): Promise<{
    totalPackages: number;
    totalSize: number;
    lastUpdated?: string;
  }> {
    try {
      const packages = await this.listPackages();
      let lastUpdated: string | undefined;
      
      for (const package of packages) {
        if (!lastUpdated || package.lastUpdated > lastUpdated) {
          lastUpdated = package.lastUpdated;
        }
      }
      
      return {
        totalPackages: packages.length,
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
      const packages = await this.listPackages();
      
      for (const package of packages) {
        try {
          const metadata = await this.getPackageMetadata(package.name);
          
          // Check metadata consistency
          if (metadata.name !== package.name) {
            issues.push(`Name mismatch in package '${package.name}': package.yml says '${metadata.name}'`);
          }
          
          if (semver.neq(metadata.version, package.version)) {
            issues.push(`Version mismatch in package '${package.name}': registry says '${package.version}', package.yml says '${metadata.version}'`);
          }
          
        } catch (error) {
          issues.push(`Failed to validate package '${package.name}': ${error}`);
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
