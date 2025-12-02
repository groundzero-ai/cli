import { resolve, relative } from 'path';

import type { CommandResult } from '../../types/index.js';
import type { Platform } from '../platforms.js';
import { getDetectedPlatforms } from '../platforms.js';
import { buildMappingAndWriteIndex } from './package-index-updater.js';
import { readPackageFilesForRegistry } from '../../utils/package-copy.js';
import { ensurePackageWithYml } from '../../utils/package-management.js';
import { isWithinDirectory } from '../../utils/path-normalization.js';
import { exists, isDirectory, isFile, ensureDir } from '../../utils/fs.js';
import { logger } from '../../utils/logger.js';
import { collectSourceEntries } from './source-collector.js';
import {
  applyPlatformSpecificPaths,
  type PlatformPathTransformOptions
} from './platform-path-transformer.js';
import { copyFilesWithConflictResolution } from './add-conflict-handler.js';
import { 
  detectPackageContext, 
  getNoPackageDetectedMessage,
  type PackageContext 
} from '../package-context.js';
import { DIR_PATTERNS } from '../../constants/index.js';

export interface AddPipelineOptions {
  platformSpecific?: boolean;
}

export interface AddPipelineResult {
  packageName: string;
  filesAdded: number;
}

/**
 * Resolution result from argument parsing.
 */
type AddTargetResolution =
  | { type: 'detected'; context: PackageContext; inputPath: string }
  | { type: 'named'; packageName: string; inputPath: string };

export async function runAddPipeline(
  packageOrPath: string | undefined,
  pathArg: string | undefined,
  options: AddPipelineOptions = {}
): Promise<CommandResult<AddPipelineResult>> {
  const cwd = process.cwd();
  const resolved = await resolveAddTargets(cwd, packageOrPath, pathArg);

  const resolvedInputPath = resolve(cwd, resolved.inputPath);
  await validateSourcePath(resolvedInputPath, cwd);

  const inputIsDirectory = await isDirectory(resolvedInputPath);
  const inputIsFile = !inputIsDirectory && (await isFile(resolvedInputPath));

  let entries = await collectSourceEntries(resolvedInputPath, cwd);
  if (entries.length === 0) {
    throw new Error(`No supported files found in ${resolved.inputPath}`);
  }

  if (options.platformSpecific) {
    const transformOptions: PlatformPathTransformOptions = {
      inputIsDirectory,
      inputIsFile
    };
    entries = applyPlatformSpecificPaths(cwd, entries, resolvedInputPath, transformOptions);
  }

  // Build package context based on resolution type
  const packageContext = await buildAddPackageContext(cwd, resolved);

  // Ensure the package files directory exists
  await ensureDir(packageContext.packageFilesDir);

  const changedFiles = await copyFilesWithConflictResolution(packageContext, entries);

  await updatePackageIndex(cwd, packageContext);

  if (changedFiles.length > 0) {
    logger.info(`Added ${changedFiles.length} file(s) to package '${packageContext.name}'.`);
  } else {
    logger.info('No files were added or modified.');
  }

  return {
    success: true,
    data: {
      packageName: packageContext.name,
      filesAdded: changedFiles.length
    }
  };
}

async function resolveAddTargets(
  cwd: string,
  packageOrPath: string | undefined,
  pathArg: string | undefined
): Promise<AddTargetResolution> {
  if (!packageOrPath && !pathArg) {
    throw new Error(
      "You must provide at least a path to add files from (e.g. 'opkg add ./ai/helpers')."
    );
  }

  // Two arguments: explicit package name + path
  if (packageOrPath && pathArg) {
    return { type: 'named', packageName: packageOrPath, inputPath: pathArg };
  }

  // Single argument: must be a path, infer package from context
  const singleArg = packageOrPath ?? pathArg!;
  const resolvedPath = resolve(cwd, singleArg);

  if (!(await exists(resolvedPath))) {
    throw new Error(
      `Path '${singleArg}' does not exist. ` +
        `To add files to a named package, run: opkg add <package-name> <path>`
    );
  }

  // Detect package context
  const context = await detectPackageContext(cwd);
  if (!context) {
    throw new Error(getNoPackageDetectedMessage());
  }

  return { type: 'detected', context, inputPath: singleArg };
}

async function buildAddPackageContext(
  cwd: string,
  resolved: AddTargetResolution
): Promise<PackageContext> {
  if (resolved.type === 'detected') {
    // Already have full context from detection
    return resolved.context;
  }

  // Named package: check if it matches root, otherwise use/create nested
  const existingContext = await detectPackageContext(cwd, resolved.packageName);
  
  if (existingContext) {
    return existingContext;
  }

  // Package doesn't exist - create as nested package
  const ensured = await ensurePackageWithYml(cwd, resolved.packageName, { interactive: true });
  
  return {
    name: ensured.normalizedName,
    version: ensured.packageConfig.version,
    config: ensured.packageConfig,
    packageYmlPath: ensured.packageYmlPath,
    packageFilesDir: ensured.packageDir,
    location: 'nested',
    isCwdPackage: false,
    isNew: ensured.isNew
  };
}

async function validateSourcePath(resolvedPath: string, cwd: string): Promise<void> {
  if (!(await exists(resolvedPath))) {
    throw new Error(`Path not found: ${relative(cwd, resolvedPath) || resolvedPath}`);
  }

  if (!isWithinDirectory(cwd, resolvedPath)) {
    throw new Error('Path must be within the current working directory.');
  }

  const openpackageDir = resolve(cwd, DIR_PATTERNS.OPENPACKAGE);
  if (isWithinDirectory(openpackageDir, resolvedPath)) {
    throw new Error('Cannot add files from the .openpackage directory.');
  }
}

async function updatePackageIndex(
  cwd: string,
  packageContext: PackageContext
): Promise<void> {
  const packageFiles = await readPackageFilesForRegistry(packageContext.packageFilesDir);
  const detectedPlatforms: Platform[] = await getDetectedPlatforms(cwd);
  await buildMappingAndWriteIndex(
    cwd,
    packageContext.name,
    packageFiles,
    detectedPlatforms,
    {
      preserveExactPaths: true,
      versionOverride: packageContext.version
    }
  );
}
