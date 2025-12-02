import { dirname, join } from 'path';

import { DIR_PATTERNS } from '../../constants/index.js';
import type { PackageFile } from '../../types/index.js';
import { ensureDir, exists, readTextFile, writeTextFile } from '../../utils/fs.js';
import { safePrompts } from '../../utils/prompts.js';
import { UserCancellationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import type { SourceEntry } from './source-collector.js';
import type { PackageContext } from '../package-context.js';

type ConflictDecision = 'keep-existing' | 'overwrite';

/**
 * Resolve the target path for a registry path.
 * - If registryPath starts with .openpackage/, write to content directory
 * - Otherwise, write to package root directory
 */
function resolveTargetPath(packageContext: PackageContext, registryPath: string): string {
  const openpackagePrefix = `${DIR_PATTERNS.OPENPACKAGE}/`;
  
  if (registryPath.startsWith(openpackagePrefix)) {
    // Universal content: strip prefix and write to content directory
    const relativePath = registryPath.slice(openpackagePrefix.length);
    return join(packageContext.packageFilesDir, relativePath);
  }
  
  // Root-level content: write to package root directory
  return join(packageContext.packageRootDir, registryPath);
}

export async function copyFilesWithConflictResolution(
  packageContext: PackageContext,
  entries: SourceEntry[]
): Promise<PackageFile[]> {
  const changedFiles: PackageFile[] = [];
  const { name } = packageContext;

  for (const entry of entries) {
    // Resolve target path based on registry path format
    const destination = resolveTargetPath(packageContext, entry.registryPath);

    const sourceContent = await readTextFile(entry.sourcePath);
    const destExists = await exists(destination);

    if (destExists) {
      const existingContent = await readTextFile(destination).catch(() => '');

      if (existingContent === sourceContent) {
        logger.debug(`Skipping unchanged file: ${entry.registryPath}`);
        continue;
      }

      const decision = await promptConflictDecision(name, entry.registryPath);
      if (decision === 'keep-existing') {
        logger.debug(`Kept existing file for ${entry.registryPath}`);
        continue;
      }
    }

    await ensureDir(dirname(destination));
    await writeTextFile(destination, sourceContent);

    changedFiles.push({
      path: entry.registryPath,
      content: sourceContent,
      encoding: 'utf8'
    });
  }

  return changedFiles;
}

async function promptConflictDecision(packageName: string, registryPath: string): Promise<ConflictDecision> {
  const response = await safePrompts({
    type: 'select',
    name: 'decision',
    message: `File '${registryPath}' already exists in package '${packageName}'. Choose how to proceed:`,
    choices: [
      { title: 'Keep existing file (skip)', value: 'keep-existing' },
      { title: 'Replace with workspace file', value: 'overwrite' },
      { title: 'Cancel operation', value: 'cancel' }
    ]
  });

  if (response.decision === 'cancel') {
    throw new UserCancellationError();
  }

  return response.decision as ConflictDecision;
}

