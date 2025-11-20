import { FILE_PATTERNS } from "../../constants/index.js";
import { DiscoveredFile } from "../../types";
import { getFileMtime, Platformish } from "../../utils/file-processing.js";
import { exists, isDirectory, readTextFile } from "../../utils/fs.js";
import { findFilesByExtension } from "../../utils/file-processing.js";
import { logger } from "../../utils/logger.js";
import { calculateFileHash } from "../../utils/hash-utils.js";
import { obtainSourceDirAndRegistryPath } from "./file-discovery.js";
import { arePackageNamesEquivalent } from "../../utils/package-name.js";

/**
 * Determine if a markdown file should be included based on frontmatter rules
 */
export function shouldIncludeMarkdownFile(
  mdFile: { relativePath: string },
  frontmatter: any,
  platform: Platformish,
  packageName: string,
): boolean {
  // For directory mode in platform directories, include files without conflicting frontmatter
  // if (isDirectoryMode) {
  //   if (!frontmatter || !frontmatter.pkg || frontmatter.pkg.name === packageName) {
  //     logger.debug(`Including ${mdFile.relativePath} from ${sourceDir} (directory mode, no conflicting frontmatter)`);
  //     return true;
  //   }
  //   logger.debug(`Skipping ${mdFile.relativePath} from ${sourceDir} (directory mode, conflicting frontmatter)`);
  //   return false;
  // }

  // Otherwise, include files with matching frontmatter
  if (frontmatter?.pkg?.name && arePackageNamesEquivalent(frontmatter.pkg.name, packageName)) {
    logger.debug(`Including ${mdFile.relativePath} from ${platform} (matches package name in frontmatter)`);
    return true;
  }

  logger.debug(`Skipping ${mdFile.relativePath} from ${platform} (no matching frontmatter)`);
  return false;
}

/**
 * Process a single markdown file for discovery - common logic used by multiple discovery methods
 */
async function processMdFileForDiscovery(
  file: { fullPath: string; relativePath: string },
  packageName: string,
  platform: Platformish,
  registryPathPrefix: string,
): Promise<DiscoveredFile | null> {
  try {
    const content = await readTextFile(file.fullPath);
    // Frontmatter support removed - always include markdown files
    const shouldInclude = true;
    if (!shouldInclude) {
      return null;
    }

    try {
      const mtime = await getFileMtime(file.fullPath);
      const contentHash = await calculateFileHash(content);
      const { sourceDir, registryPath } = await obtainSourceDirAndRegistryPath(file, platform, registryPathPrefix);

      const result: DiscoveredFile = {
        fullPath: file.fullPath,
        relativePath: file.relativePath,
        sourceDir,
        registryPath,
        mtime,
        contentHash
      };

      // Frontmatter support removed - platformSpecific detection disabled

      return result;
    } catch (error) {
      logger.warn(`Failed to process file metadata for ${file.relativePath}: ${error}`);
    }
      
  } catch (error) {
    logger.warn(`Failed to read ${file.relativePath}: ${error}`);
  }
  return null;
}

/**
 * Discover markdown files in a directory with specified patterns and inclusion rules
 */
export async function discoverMdFiles(
  directoryPath: string,
  packageName: string,
  platform: Platformish,
  registryPathPrefix: string = '',
): Promise<DiscoveredFile[]> {

  if (!(await exists(directoryPath)) || !(await isDirectory(directoryPath))) {
    return [];
  }

  // Find files with the specified patterns
  const allFiles: Array<{ fullPath: string; relativePath: string }> = [];

  // Recursive search using findFilesByExtension
  const files = await findFilesByExtension(directoryPath, [...FILE_PATTERNS.MARKDOWN_FILES]);
  allFiles.push(...files);

  // Process files in parallel using the extracted helper
  const processPromises = allFiles.map(async (file) =>
    processMdFileForDiscovery(file, packageName, platform, registryPathPrefix)
  );

  const results = await Promise.all(processPromises);
  return results.filter((result): result is DiscoveredFile => result !== null);
}