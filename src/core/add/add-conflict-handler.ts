import { dirname } from 'path';

import type { PackageFile, PackageYml } from '../../types/index.js';
import { ensureDir, exists, readTextFile, writeTextFile } from '../../utils/fs.js';
import { resolveTargetDirectory, resolveTargetFilePath } from '../../utils/platform-mapper.js';
import { safePrompts } from '../../utils/prompts.js';
import { UserCancellationError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';
import type { SourceEntry } from './source-collector.js';

interface EnsuredPackageContext {
  normalizedName: string;
  packageDir: string;
  packageConfig: PackageYml;
}

type ConflictDecision = 'keep-existing' | 'overwrite';

export async function copyFilesWithConflictResolution(
  ensuredPackage: EnsuredPackageContext,
  entries: SourceEntry[]
): Promise<PackageFile[]> {
  const changedFiles: PackageFile[] = [];
  const { packageDir, normalizedName } = ensuredPackage;

  for (const entry of entries) {
    const targetDir = resolveTargetDirectory(packageDir, entry.registryPath);
    const destination = resolveTargetFilePath(targetDir, entry.registryPath);

    const sourceContent = await readTextFile(entry.sourcePath);
    const destExists = await exists(destination);

    if (destExists) {
      const existingContent = await readTextFile(destination).catch(() => '');

      if (existingContent === sourceContent) {
        logger.debug(`Skipping unchanged file: ${entry.registryPath}`);
        continue;
      }

      const decision = await promptConflictDecision(normalizedName, entry.registryPath);
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

