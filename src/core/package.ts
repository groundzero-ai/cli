import { join, relative, dirname, basename } from 'path';
import { isJunk } from 'junk';
import { Package, PackageFile } from '../types/index.js';
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
  PackageNotFoundError,
  InvalidPackageError,
} from '../utils/errors.js';
import { validatePackageName } from '../utils/package-name.js';
import {
  getPackagePath,
  getPackageVersionPath,
  getLatestPackageVersion,
  listPackageVersions
} from './directory.js';
import { parsePackageYml } from '../utils/package-yml.js';
import {
  resolveVersionRange,
  isExactVersion,
  isWipVersion
} from '../utils/version-ranges.js';
import {
  readPackageLink,
  getPackageLinkPath,
  type PackageLinkMetadata,
  PACKAGE_LINK_FILENAME
} from '../utils/package-link-yml.js';

/**
 * Package management operations
 */

export class PackageManager {
  
  
  /**
   * Load a package from the registry (latest version by default)
   */
  async loadPackage(packageName: string, version?: string): Promise<Package> {
    logger.debug(`Loading package: ${packageName}`, { version });
    
    validatePackageName(packageName);
    
    let targetVersion: string | null;
    
    if (version) {
      // Check if it's a version range or exact version
      if (isExactVersion(version)) {
        targetVersion = version;
      } else {
        // It's a version range - resolve it to a specific version
        const availableVersions = await listPackageVersions(packageName);
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
      targetVersion = await getLatestPackageVersion(packageName);
    }
    
    if (!targetVersion) {
      throw new PackageNotFoundError(packageName);
    }
    
    const packagePath = getPackageVersionPath(packageName, targetVersion);
    if (!(await exists(packagePath))) {
      throw new PackageNotFoundError(packageName);
    }
    
    try {
      const linkMetadata = await readPackageLink(packageName, targetVersion);
      if (linkMetadata) {
        return await this.loadPackageFromLink(packageName, targetVersion, linkMetadata);
      }

      // Load package.yml for metadata
      const packageYmlPath = join(packagePath, 'package.yml');
      if (!(await exists(packageYmlPath))) {
        if (isWipVersion(targetVersion)) {
          const linkPath = getPackageLinkPath(packageName, targetVersion);
          throw createBrokenLinkError(
            packageName,
            targetVersion,
            linkPath,
            `Expected ${PACKAGE_LINK_FILENAME} pointing to a valid source workspace`
          );
        }
        throw new PackageNotFoundError(packageName);
      }
      
      const metadata = await parsePackageYml(packageYmlPath);
      
      // Discover all files in the package directory
      const files = await this.discoverPackageFiles(packagePath);
      
      return { metadata, files };
    } catch (error) {
      if (error instanceof PackageNotFoundError) {
        throw error;
      }
      logger.error(`Failed to load package: ${packageName}`, { error });
      throw new InvalidPackageError(`Failed to load package: ${error}`);
    }
  }
  
  /**
   * Save a package to the registry (versioned)
   */
  async savePackage(pkg: Package): Promise<void> {
    const { metadata, files } = pkg;
    const packagePath = getPackageVersionPath(metadata.name, metadata.version);
    
    logger.debug(`Saving package: ${metadata.name}@${metadata.version}`, { packagePath });
    
    try {
      // Ensure the version directory exists
      await ensureDir(packagePath);
      
      // Save files
      for (const file of files) {
        const fullPath = join(packagePath, file.path);
        await ensureDir(dirname(fullPath));
        await writeTextFile(fullPath, file.content, (file.encoding as BufferEncoding) || 'utf8');
      }
      
      logger.info(`Package '${metadata.name}@${metadata.version}' saved successfully`);
    } catch (error) {
      logger.error(`Failed to save package: ${metadata.name}@${metadata.version}`, { error });
      throw new InvalidPackageError(`Failed to save package: ${error}`);
    }
  }
  
  /**
   * Delete a specific version of a package
   */
  async deletePackageVersion(packageName: string, version: string): Promise<void> {
    logger.info(`Deleting package version: ${packageName}@${version}`);
    
    validatePackageName(packageName);
    
    const packagePath = getPackageVersionPath(packageName, version);
    
    if (!(await exists(packagePath))) {
      throw new PackageNotFoundError(`${packageName}@${version}`);
    }
    
    try {
      await remove(packagePath);
      logger.info(`Package version '${packageName}@${version}' deleted successfully`);
    } catch (error) {
      logger.error(`Failed to delete package version: ${packageName}@${version}`, { error });
      throw new InvalidPackageError(`Failed to delete package version: ${error}`);
    }
  }
  
  /**
   * Delete all versions of a package
   */
  async deletePackage(packageName: string): Promise<void> {
    logger.info(`Deleting all versions of package: ${packageName}`);
    
    validatePackageName(packageName);
    
    const packagePath = getPackagePath(packageName);
    
    if (!(await exists(packagePath))) {
      throw new PackageNotFoundError(packageName);
    }
    
    try {
      await remove(packagePath);
      logger.info(`All versions of package '${packageName}' deleted successfully`);
    } catch (error) {
      logger.error(`Failed to delete package: ${packageName}`, { error });
      throw new InvalidPackageError(`Failed to delete package: ${error}`);
    }
  }
  
  /**
   * Check if a package exists in the registry (any version)
   */
  async packageExists(packageName: string): Promise<boolean> {
    validatePackageName(packageName);
    const latestVersion = await getLatestPackageVersion(packageName);
    return latestVersion !== null;
  }
  
  /**
   * Discover all files in a package directory
   */
  private async loadPackageFromLink(
    packageName: string,
    version: string,
    metadata: PackageLinkMetadata
  ): Promise<Package> {
    const linkPath = getPackageLinkPath(packageName, version);
    const sourcePath = metadata.sourcePath;

    if (!sourcePath) {
      throw createBrokenLinkError(packageName, version, linkPath, 'Missing sourcePath in link metadata');
    }

    if (!(await exists(sourcePath))) {
      throw createBrokenLinkError(packageName, version, linkPath, `Source path '${sourcePath}' does not exist`);
    }

    const packageYmlPath = join(sourcePath, 'package.yml');
    if (!(await exists(packageYmlPath))) {
      throw createBrokenLinkError(packageName, version, linkPath, `Expected package.yml under '${sourcePath}'`);
    }

    const linkedMetadata = await parsePackageYml(packageYmlPath);
    linkedMetadata.version = version;
    const files = await this.discoverPackageFiles(sourcePath);

    return { metadata: linkedMetadata, files };
  }

  private async discoverPackageFiles(packagePath: string): Promise<PackageFile[]> {
    const files: PackageFile[] = [];

    try {
      // Include all file types (no filtering)
      // Get all files recursively in the package directory
      for await (const fullPath of walkFiles(packagePath)) {
        const relativePath = relative(packagePath, fullPath);

        // Filter out junk files
        if (isJunk(basename(relativePath))) {
          continue;
        }

        const content = await readTextFile(fullPath);

        files.push({
          path: relativePath,
          content,
          encoding: 'utf8'
        });
      }

      logger.debug(`Discovered ${files.length} files in package directory`, { packagePath });
      return files;
    } catch (error) {
      logger.error(`Failed to discover files in package directory: ${packagePath}`, { error });
      throw new InvalidPackageError(`Failed to discover package files: ${error}`);
    }
  }
  
  
}

// Create and export a singleton instance
export const packageManager = new PackageManager();

function createBrokenLinkError(
  packageName: string,
  version: string,
  linkPath: string,
  reason: string
): InvalidPackageError {
  return new InvalidPackageError(
    `WIP link for ${packageName}@${version} is invalid: ${reason}. Expected metadata at ${linkPath}. Re-run 'opkg save' to regenerate the link or 'opkg pack' to create a stable version.`,
  );
}
