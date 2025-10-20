import { DiscoveredFile } from "../../types"
import { Platformish } from "../../utils/discovery/file-processing"
import { exists, isDirectory } from "../../utils/fs"
import { discoverMdFiles } from "./md-files-discovery"
import { discoverIndexYmlMarkedFiles } from "./index-files-discovery"
import { PLATFORM_DIRS } from "../../constants"
import { getPlatformDefinition } from "../platforms"
import { mapPlatformFileToUniversal } from "../../utils/platform-mapper"
import { join } from "path"

export async function obtainSourceDirAndRegistryPath(
  file: { fullPath: string; relativePath: string },
  platform: Platformish,
  registryPathPrefix: string
): Promise<{ sourceDir: string, registryPath: string }> {

  const sourceDir = platform === 'ai' ? PLATFORM_DIRS.AI : getPlatformDefinition(platform).rootDir;


  let registryPath: string
  if (platform !== "ai") {
    // Universal file from platform directory - use the mapper to get universal path
    const mapping = mapPlatformFileToUniversal(file.fullPath)
    if (mapping) {
      registryPath = join(mapping.subdir, mapping.relPath)
    } else {
      // Fallback to old logic
      registryPath = registryPathPrefix
        ? join(registryPathPrefix, file.relativePath)
        : file.relativePath
    }
  } else {
    // Platform-specific file or directory mode - use normal registry path logic
    registryPath = registryPathPrefix
      ? join(registryPathPrefix, file.relativePath)
      : file.relativePath
  }

  return { sourceDir, registryPath }
}

export async function discoverFiles(
  rootDir: string,
  formulaName: string,
  platform: Platformish,
  registryPathPrefix: string
): Promise<DiscoveredFile[]> {
  if (!(await exists(rootDir)) || !(await isDirectory(rootDir))) {
    return []
  }

  const mdFiles = await discoverMdFiles(
    rootDir,
    formulaName,
    platform,
    registryPathPrefix
  )
  const indexYmlFiles = await discoverIndexYmlMarkedFiles(
    rootDir,
    formulaName,
    platform,
    registryPathPrefix
  )

  return [...mdFiles, ...indexYmlFiles];
}

/**
 * Discover markdown files in a directory with specified patterns and inclusion rules
 */
// export async function discoverFiles(
//   directoryPath: string,
//   formulaName: string,
//   platform: Platformish,
//   registryPathPrefix: string = '',
// ): Promise<DiscoveredFile[]> {

//   if (!(await exists(directoryPath)) || !(await isDirectory(directoryPath))) {
//     return [];
//   }

//   // Find files with the specified patterns
//   const allFiles: Array<{ fullPath: string; relativePath: string }> = [];

//   // Recursive search using findFilesByExtension
//   const files = await findFilesByExtension(directoryPath, filePatterns);
//   allFiles.push(...files);

//   // Process files in parallel using the extracted helper
//   const processPromises = allFiles.map(async (file) =>
//     processMdFileForDiscovery(file, formulaName, platform, registryPathPrefix)
//   );

//   const results = await Promise.all(processPromises);
//   return results.filter((result): result is DiscoveredFile => result !== null);
// }
