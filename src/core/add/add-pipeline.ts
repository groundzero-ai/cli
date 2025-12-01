import { resolve, relative } from 'path';

import type { CommandResult } from '../../types/index.js';
import type { Platform } from '../platforms.js';
import { getDetectedPlatforms } from '../platforms.js';
import { buildMappingAndWriteIndex } from './package-index-updater.js';
import { readPackageFilesForRegistry } from '../../utils/package-copy.js';
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
import { detectPackageContext, getNoPackageDetectedMessage } from '../save/package-detection.js';

export interface AddPipelineOptions {
  platformSpecific?: boolean;
}

export interface AddPipelineResult {
  packageName: string;
  filesAdded: number;
}

export async function runAddPipeline(
  packageOrPath: string | undefined,
  pathArg: string | undefined,
  options: AddPipelineOptions = {}
): Promise<CommandResult<AddPipelineResult>> {
  const { packageName, inputPath } = await resolveAddTargets(packageOrPath, pathArg);
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

interface ResolvedAddTargets {
  packageName: string;
  inputPath: string;
}

async function resolveAddTargets(
  packageOrPath: string | undefined,
  pathArg: string | undefined
): Promise<ResolvedAddTargets> {
  if (!packageOrPath && !pathArg) {
    throw new Error(
      "You must provide at least a path to add files from (e.g. 'opkg add ./ai/helpers')."
    );
  }

  const cwd = process.cwd();

  if (packageOrPath && pathArg) {
    return { packageName: packageOrPath, inputPath: pathArg };
  }

  const singleArg = packageOrPath ?? pathArg!;
  const resolvedPath = resolve(cwd, singleArg);

  if (await exists(resolvedPath)) {
    const detectedContext = await detectPackageContext(cwd);
    if (!detectedContext) {
      throw new Error(getNoPackageDetectedMessage());
    }
    return { packageName: detectedContext.config.name, inputPath: singleArg };
  }

  throw new Error(
    `Path '${singleArg}' does not exist. ` +
      `To add files to a named package, run: opkg add <package-name> <path>`
  );
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
  const packageFiles = await readPackageFilesForRegistry(ensuredPackage.packageDir);
  const detectedPlatforms: Platform[] = await getDetectedPlatforms(cwd);
  await buildMappingAndWriteIndex(
    cwd,
    ensuredPackage.normalizedName,
    packageFiles,
    detectedPlatforms,
    { preserveExactPaths: true }
  );
}
