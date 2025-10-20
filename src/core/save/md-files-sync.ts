import { FormulaFile } from "../../types";
import { PlatformSyncResult } from "./platform-sync.js";
import { resolveInstallTargets } from "../../utils/platform-mapper.js";
import { FILE_PATTERNS } from "../../constants/index.js";
import { mergePlatformYamlOverride } from "../../utils/platform-yaml-merge.js";
import { writeIfChanged } from "../install/file-updater.js";
import { relative } from "path";
import { logger } from "../../utils/logger.js";

/**
 * Sync a universal markdown file with optional YAML override merging
 */
export async function syncUniversalMarkdown(
  cwd: string,
  universalSubdir: string,
  relPath: string,
  content: string,
  formulaFiles: FormulaFile[],
  result: PlatformSyncResult
): Promise<void> {
  const targets = await resolveInstallTargets(cwd, {
    universalSubdir: universalSubdir as any,
    relPath,
    sourceExt: FILE_PATTERNS.MD_FILES
  });

  for (const target of targets) {
    const finalContent = mergePlatformYamlOverride(
      content,
      target.platform,
      universalSubdir,
      relPath,
      formulaFiles
    );

    const outcome = await writeIfChanged(target.absFile, finalContent);
    const rel = relative(cwd, target.absFile);
    if (outcome === 'created') {
      result.created.push(rel);
      logger.debug(`Created synced file: ${target.absFile}`);
    } else if (outcome === 'updated') {
      result.updated.push(rel);
      logger.debug(`Updated synced file: ${target.absFile}`);
    } else {
      logger.debug(`Synced file unchanged: ${target.absFile}`);
    }
  }
}
