import { FILE_PATTERNS } from '../../constants/index.js';
import { DiscoveredFile } from '../../types';
import { getFileMtime, findFilesByExtension } from '../../utils/file-processing.js';
import { exists, isDirectory, readTextFile } from '../../utils/fs.js';
import { logger } from '../../utils/logger.js';
import { calculateFileHash } from '../../utils/hash-utils.js';
import { obtainSourceDirAndRegistryPath, type DiscoveryPathContext } from './file-discovery.js';

/**
 * Process a single markdown file for discovery - common logic used by multiple discovery methods
 */
async function processMdFileForDiscovery(
  file: { fullPath: string; relativePath: string },
  packageName: string,
  context: DiscoveryPathContext
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
      const { sourceDir, registryPath } = await obtainSourceDirAndRegistryPath(file, context);

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
  context: DiscoveryPathContext
): Promise<DiscoveredFile[]> {

  if (!(await exists(directoryPath)) || !(await isDirectory(directoryPath))) {
    return [];
  }

  // Find files with the specified patterns
  const allFiles: Array<{ fullPath: string; relativePath: string }> = [];

  // Recursive search using findFilesByExtension
  const files = await findFilesByExtension(
    directoryPath,
    [...FILE_PATTERNS.MARKDOWN_FILES],
    directoryPath,
    { excludeDirs: context.excludeDirs }
  );
  allFiles.push(...files);

  // Process files in parallel using the extracted helper
  const processPromises = allFiles.map(async (file) =>
    processMdFileForDiscovery(file, packageName, context)
  );

  const results = await Promise.all(processPromises);
  return results.filter((result): result is DiscoveredFile => result !== null);
}