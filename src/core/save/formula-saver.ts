import { FormulaFile, FormulaYml } from "../../types";
import { normalizeFormulaName } from "../../utils/formula-name.js";
import { ensureDir, writeTextFile } from "../../utils/fs.js";
import { logger } from "../../utils/logger.js";
import { resolveTargetDirectory, resolveTargetFilePath } from "../../utils/platform-mapper.js";
import { getFormulaVersionPath } from "../directory.js";
import { UTF8_ENCODING } from "./constants.js";
import { FormulaYmlInfo } from "./formula-yml-generator.js";

/**
 * Save formula to local registry
 */
export async function saveFormulaToRegistry(
  formulaInfo: FormulaYmlInfo,
  files: FormulaFile[],
  silent: boolean = true
): Promise<{ success: boolean; error?: string; updatedConfig?: FormulaYml }> {

  const config = formulaInfo.config;

  try {
    // Ensure formula name is normalized for consistent registry paths
    const normalizedConfig = { ...config, name: normalizeFormulaName(config.name) };
    const targetPath = getFormulaVersionPath(normalizedConfig.name, normalizedConfig.version);
    await ensureDir(targetPath);
    
    // Group files by target directory
    const directoryGroups = new Map<string, FormulaFile[]>();
    
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
    
    if (!silent) {
      logger.info(`Formula '${normalizedConfig.name}@${normalizedConfig.version}' saved to local registry`);
    }
    return { success: true, updatedConfig: normalizedConfig };
  } catch (error) {
    logger.error(`Failed to save formula: ${error}`);
    return { success: false, error: `Failed to save formula: ${error}` };
  }
}
