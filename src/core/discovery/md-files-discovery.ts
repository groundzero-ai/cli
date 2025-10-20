import { FILE_PATTERNS } from "../../constants/index.js";
import { DiscoveredFile } from "../../types";
import { getFileMtime, Platformish } from "../../utils/discovery/file-processing.js";
import { exists, isDirectory, readTextFile } from "../../utils/fs.js";
import { findFilesByExtension } from "../../utils/discovery/file-processing.js";
import { parseMarkdownFrontmatter } from "../../utils/md-frontmatter.js";
import { logger } from "../../utils/logger.js";
import { calculateFileHash } from "../../utils/hash-utils.js";
import { obtainSourceDirAndRegistryPath } from "./file-discovery.js";

/**
 * Determine if a markdown file should be included based on frontmatter rules
 */
export function shouldIncludeMarkdownFile(
  mdFile: { relativePath: string },
  frontmatter: any,
  platform: Platformish,
  formulaName: string,
): boolean {
  // For directory mode in platform directories, include files without conflicting frontmatter
  // if (isDirectoryMode) {
  //   if (!frontmatter || !frontmatter.formula || frontmatter.formula.name === formulaName) {
  //     logger.debug(`Including ${mdFile.relativePath} from ${sourceDir} (directory mode, no conflicting frontmatter)`);
  //     return true;
  //   }
  //   logger.debug(`Skipping ${mdFile.relativePath} from ${sourceDir} (directory mode, conflicting frontmatter)`);
  //   return false;
  // }

  // Otherwise, include files with matching frontmatter
  if (frontmatter?.formula?.name === formulaName) {
    logger.debug(`Including ${mdFile.relativePath} from ${platform} (matches formula name in frontmatter)`);
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
  formulaName: string,
  platform: Platformish,
  registryPathPrefix: string,
): Promise<DiscoveredFile | null> {
  try {
    const content = await readTextFile(file.fullPath);
    let frontmatter;

    try {
      frontmatter = parseMarkdownFrontmatter(content);
    } catch (parseError) {
      logger.debug(`Failed to parse frontmatter in ${file.relativePath}: ${parseError}`);
      frontmatter = null;
    }

    const shouldInclude = shouldIncludeMarkdownFile(file, frontmatter, platform, formulaName);
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

      if (frontmatter?.formula?.platformSpecific === true) {
        result.forcePlatformSpecific = true;
      }

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
  formulaName: string,
  platform: Platformish,
  registryPathPrefix: string = '',
): Promise<DiscoveredFile[]> {

  if (!(await exists(directoryPath)) || !(await isDirectory(directoryPath))) {
    return [];
  }

  // Find files with the specified patterns
  const mdFilePatterns = [FILE_PATTERNS.MD_FILES, FILE_PATTERNS.MDC_FILES];
  const allFiles: Array<{ fullPath: string; relativePath: string }> = [];

  // Recursive search using findFilesByExtension
  const files = await findFilesByExtension(directoryPath, mdFilePatterns);
  allFiles.push(...files);

  // Process files in parallel using the extracted helper
  const processPromises = allFiles.map(async (file) =>
    processMdFileForDiscovery(file, formulaName, platform, registryPathPrefix)
  );

  const results = await Promise.all(processPromises);
  return results.filter((result): result is DiscoveredFile => result !== null);
}