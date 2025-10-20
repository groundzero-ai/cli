import { PlatformSyncResult } from "./platform-sync.js";
import { getPlatformDefinition, getDetectedPlatforms } from "../platforms.js";
import {  type UniversalSubdir } from "../../constants/index.js";
import { writeIfChanged } from "../install/file-updater.js";
import { relative, join } from "path";
import { logger } from "../../utils/logger.js";

/**
 * Sync a generic (non-markdown) universal file preserving filename and extension
 */
export async function syncGenericFile(
  cwd: string,
  universalSubdir: string,
  relPath: string,
  content: string,
  result: PlatformSyncResult
): Promise<void> {
  // Resolve targets manually to preserve original extension (avoid writeExt conversion)
  const detected = await getDetectedPlatforms(cwd);

  for (const platform of detected) {
    try {
      const def = getPlatformDefinition(platform as any);
      const subdirDef = def.subdirs[universalSubdir as UniversalSubdir];
      if (!subdirDef) continue;

      const absDir = join(cwd, def.rootDir, subdirDef.path);
      const targetFile = join(absDir, relPath);

      const outcome = await writeIfChanged(targetFile, content);
      const rel = relative(cwd, targetFile);
      if (outcome === 'created') {
        result.created.push(rel);
        logger.debug(`Created synced file: ${targetFile}`);
      } else if (outcome === 'updated') {
        result.updated.push(rel);
        logger.debug(`Updated synced file: ${targetFile}`);
      } else {
        logger.debug(`Synced file unchanged: ${targetFile}`);
      }
    } catch (error) {
      logger.warn(`Failed to sync generic file for platform ${platform}: ${error}`);
    }
  }
}