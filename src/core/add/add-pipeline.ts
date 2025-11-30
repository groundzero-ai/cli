import { resolve, relative } from 'path';

import type { CommandResult } from '../../types/index.js';
import type { Platform } from '../platforms.js';
import { getDetectedPlatforms } from '../platforms.js';
import { buildMappingAndWriteIndex } from './package-index-updater.js';
import { readLocalPackageFilesForIndex } from '../../utils/package-local-files.js';
import {
  ensurePackageWithYml,
  type EnsurePackageWithYmlResult
} from '../../utils/package-management.js';
import { isWithinDirectory } from '../../utils/path-normalization.js';
import { getLocalOpenPackageDir } from '../../utils/paths.js';
import { exists, isDirectory, isFile } from '../../utils/fs.js';
import { logger } from '../../utils/logger.js';
import { collectSourceEntries } from './source-collector.js';
import {
  applyPlatformSpecificPaths,
  type PlatformPathTransformOptions
} from './platform-path-transformer.js';
import { copyFilesWithConflictResolution } from './add-conflict-handler.js';

export interface AddPipelineOptions {
  platformSpecific?: boolean;
}

export interface AddPipelineResult {
  packageName: string;
  filesAdded: number;
}

export async function runAddPipeline(
  packageName: string,
  inputPath: string,
  options: AddPipelineOptions = {}
): Promise<CommandResult<AddPipelineResult>> {
  const cwd = process.cwd();

  const resolvedInputPath = resolve(cwd, inputPath);
  await validateSourcePath(resolvedInputPath, cwd);

  const inputIsDirectory = await isDirectory(resolvedInputPath);
  const inputIsFile = !inputIsDirectory && (await isFile(resolvedInputPath));

  let entries = await collectSourceEntries(resolvedInputPath, cwd);
  if (entries.length === 0) {
    throw new Error(`No supported files found in ${inputPath}`);
  }

  if (options.platformSpecific) {
    const transformOptions: PlatformPathTransformOptions = {
      inputIsDirectory,
      inputIsFile
    };
    entries = applyPlatformSpecificPaths(cwd, entries, resolvedInputPath, transformOptions);
  }

  const ensuredPackage = await ensurePackageWithYml(cwd, packageName, { interactive: true });

  const changedFiles = await copyFilesWithConflictResolution(ensuredPackage, entries);

  await updatePackageIndex(cwd, ensuredPackage);

  if (changedFiles.length > 0) {
    logger.info(`Added ${changedFiles.length} file(s) to package '${ensuredPackage.normalizedName}'.`);
  } else {
    logger.info('No files were added or modified.');
  }

  return {
    success: true,
    data: {
      packageName: ensuredPackage.normalizedName,
      filesAdded: changedFiles.length
    }
  };
}

async function validateSourcePath(resolvedPath: string, cwd: string): Promise<void> {
  if (!(await exists(resolvedPath))) {
    throw new Error(`Path not found: ${relative(cwd, resolvedPath) || resolvedPath}`);
  }

  if (!isWithinDirectory(cwd, resolvedPath)) {
    throw new Error('Path must be within the current working directory.');
  }

  const openpackageDir = getLocalOpenPackageDir(cwd);
  if (isWithinDirectory(openpackageDir, resolvedPath)) {
    throw new Error('Cannot add files from the .openpackage directory.');
  }
}

async function updatePackageIndex(
  cwd: string,
  ensuredPackage: EnsurePackageWithYmlResult
): Promise<void> {
  const packageFiles = await readLocalPackageFilesForIndex(ensuredPackage.packageDir);
  const detectedPlatforms: Platform[] = await getDetectedPlatforms(cwd);
  await buildMappingAndWriteIndex(
    cwd,
    ensuredPackage.normalizedName,
    packageFiles,
    detectedPlatforms,
    { preserveExactPaths: true }
  );
}
