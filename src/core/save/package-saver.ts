import { PackageFile, PackageYml } from "../../types";
import { normalizePackageName } from "../../utils/package-name.js";
import { ensureDir, writeTextFile, remove } from "../../utils/fs.js";
import { logger } from "../../utils/logger.js";
import { resolveTargetDirectory, resolveTargetFilePath } from "../../utils/platform-mapper.js";
import { getPackageVersionPath } from "../directory.js";
import { UTF8_ENCODING } from "./constants.js";
import { PackageYmlInfo } from "./package-yml-generator.js";
import { packageVersionExists } from "../../utils/package-versioning.js";

/**
 * Save package to local registry
 */
export async function savePackageToRegistry(
  packageInfo: PackageYmlInfo,
  files: PackageFile[]
): Promise<{ success: boolean; error?: string; updatedConfig?: PackageYml }> {

  const config = packageInfo.config;

  try {
    // Ensure package name is normalized for consistent registry paths
    const normalizedConfig = { ...config, name: normalizePackageName(config.name) };
    const targetPath = getPackageVersionPath(normalizedConfig.name, normalizedConfig.version);

    // If version already exists, clear the directory first to remove old files
    if (await packageVersionExists(normalizedConfig.name, normalizedConfig.version)) {
      await remove(targetPath);
      logger.debug(`Cleared existing version directory: ${targetPath}`);
    }

    await ensureDir(targetPath);
    
    // Group files by target directory
    const directoryGroups = new Map<string, PackageFile[]>();
    
    for (const file of files) {
      const targetDir = resolveTargetDirectory(targetPath, file.path);
      if (!directoryGroups.has(targetDir)) {
        directoryGroups.set(targetDir, []);
      }
      directoryGroups.get(targetDir)!.push(file);
    }
    
    // Save files in parallel by directory
    const savePromises = Array.from(directoryGroups.entries()).map(async ([dir, dirFiles]) => {
      await ensureDir(dir);
      
      const filePromises = dirFiles.map(async (file) => {
        const filePath = resolveTargetFilePath(dir, file.path);
        await writeTextFile(filePath, file.content, (file.encoding as BufferEncoding) || UTF8_ENCODING);
      });
      
      await Promise.all(filePromises);
    });
    
    await Promise.all(savePromises);
    
    return { success: true, updatedConfig: normalizedConfig };
  } catch (error) {
    logger.error(`Failed to save package: ${error}`);
    return { success: false, error: `Failed to save package: ${error}` };
  }
}
