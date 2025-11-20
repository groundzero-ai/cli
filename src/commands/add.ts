import { Command } from 'commander';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve
} from 'path';
import {
  CommandResult,
  PackageFile,
  PackageYml
} from '../types/index.js';
import {
  FILE_PATTERNS,
  PLATFORM_DIRS,
  type Platform
} from '../constants/index.js';
import {
  getAllPlatforms,
  getDetectedPlatforms,
  getPlatformDefinition
} from '../core/platforms.js';
import {
  withErrorHandling,
  UserCancellationError
} from '../utils/errors.js';
import {
  ensureDir,
  exists,
  isDirectory,
  isFile,
  readTextFile,
  writeTextFile,
  walkFiles
} from '../utils/fs.js';
import {
  getLocalPackageDir,
  getLocalOpenPackageDir
} from '../utils/paths.js';
import {
  parsePackageYml,
  writePackageYml
} from '../utils/package-yml.js';
import {
  normalizePackageName,
  validatePackageName
} from '../utils/package-name.js';
import {
  promptPackageDetailsForNamed,
  safePrompts
} from '../utils/prompts.js';
import {
  mapPlatformFileToUniversal
} from '../utils/platform-mapper.js';
import {
  normalizePathForProcessing
} from '../utils/path-normalization.js';
import {
  suffixFileBasename,
  suffixFirstContentDir
} from '../utils/platform-specific-paths.js';
import { logger } from '../utils/logger.js';
import { buildMappingAndWriteIndex } from '../core/add/package-index-updater.js';
import { readLocalPackageFilesForIndex } from '../utils/package-local-files.js';

const PLATFORM_ROOT_FILES = buildPlatformRootFiles();

interface SourceEntry {
  sourcePath: string;
  registryPath: string;
}

interface EnsurePackageResult {
  normalizedName: string;
  formulaDir: string;
  formulaConfig: PackageYml;
}

type ConflictDecision = 'keep-existing' | 'overwrite';

interface AddCommandOptions {
  platformSpecific?: boolean;
}

export function setupAddCommand(program: Command): void {
  program
    .command('add')
    .argument('<package-name>', 'formula to add workspace files into')
    .argument('<path>', 'file or directory to add (relative to current directory)')
    .description(
      'Copy supported workspace files or directories into a local formula directory.\n' +
      'Usage examples:\n' +
      '  opn add my-formula .cursor/rules/example.md\n' +
      '  opn add my-formula ai/helpers/\n'
    )
    .option('--platform-specific', 'Save platform-specific variants for platform subdir inputs')
    .action(withErrorHandling(async (formulaName: string, inputPath: string, options: AddCommandOptions) => {
      await runAddCommand(formulaName, inputPath, options);
    }));
}

async function runAddCommand(formulaName: string, inputPath: string, options: AddCommandOptions = {}): Promise<CommandResult<void>> {
  const cwd = process.cwd();

  const ensuredPackage = await ensurePackageExists(cwd, formulaName);

  const resolvedInputPath = resolve(cwd, inputPath);
  await validateSourcePath(resolvedInputPath, cwd);

  const inputIsDirectory = await isDirectory(resolvedInputPath);
  const inputIsFile = !inputIsDirectory && await isFile(resolvedInputPath);

  let entries = await collectSourceEntries(resolvedInputPath, cwd);
  if (entries.length === 0) {
    throw new Error(`No supported files found in ${inputPath}`);
  }

  if (options.platformSpecific) {
    entries = applyPlatformSpecificPaths(
      cwd,
      entries,
      resolvedInputPath,
      {
        inputIsDirectory,
        inputIsFile
      }
    );
  }

  const changedFiles = await copyWithConflictResolution(
    ensuredPackage,
    entries
  );

  // Always update index using all candidate entries (even if nothing changed on disk)
  // Directory collapsing is now universally applied
  await updatePackageIndex(cwd, ensuredPackage);

  if (changedFiles.length > 0) {
    logger.info(`Added ${changedFiles.length} file(s) to formula '${ensuredPackage.normalizedName}'.`);
  } else {
    logger.info('No files were added or modified.');
  }

  return { success: true };
}

async function ensurePackageExists(cwd: string, formulaName: string): Promise<EnsurePackageResult> {
  validatePackageName(formulaName);
  const normalizedName = normalizePackageName(formulaName);

  const formulaDir = getLocalPackageDir(cwd, normalizedName);
  const formulaYmlPath = join(formulaDir, FILE_PATTERNS.FORMULA_YML);

  await ensureDir(formulaDir);

  let formulaConfig: PackageYml;
  if (await exists(formulaYmlPath)) {
    formulaConfig = await parsePackageYml(formulaYmlPath);
  } else {
    formulaConfig = await promptPackageDetailsForNamed(normalizedName);
    await writePackageYml(formulaYmlPath, formulaConfig);
    logger.info(`Created new formula '${formulaConfig.name}@${formulaConfig.version}' at ${relative(cwd, formulaDir)}`);
  }

  return {
    normalizedName,
    formulaDir,
    formulaConfig
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

async function collectSourceEntries(resolvedPath: string, cwd: string): Promise<SourceEntry[]> {
  const entries: SourceEntry[] = [];

  if (await isDirectory(resolvedPath)) {
    for await (const filePath of walkFiles(resolvedPath)) {
      const entry = deriveSourceEntry(filePath, cwd);
      if (!entry) {
        throw new Error(`Unsupported file inside directory: ${relative(cwd, filePath)}`);
      }
      entries.push(entry);
    }
  } else if (await isFile(resolvedPath)) {
    const entry = deriveSourceEntry(resolvedPath, cwd);
    if (!entry) {
      throw new Error(`Unsupported file: ${relative(cwd, resolvedPath)}`);
    }
    entries.push(entry);
  } else {
    throw new Error(`Unsupported path type: ${resolvedPath}`);
  }

  return entries;
}

function deriveSourceEntry(absFilePath: string, cwd: string): SourceEntry | null {
  const relativePath = relative(cwd, absFilePath);
  const normalizedRelPath = normalizePathForProcessing(relativePath);

  if (normalizedRelPath.startsWith(`${PLATFORM_DIRS.AI}/`)) {
    return {
      sourcePath: absFilePath,
      registryPath: normalizedRelPath
    };
  }

  const mapping = mapPlatformFileToUniversal(absFilePath);
  if (mapping) {
    return {
      sourcePath: absFilePath,
      registryPath: joinPathSegments(mapping.subdir, mapping.relPath)
    };
  }

  const fileName = normalizedRelPath.split('/').pop();
  if (fileName && isPlatformRootFile(fileName) && !normalizedRelPath.includes('/')) {
    return {
      sourcePath: absFilePath,
      registryPath: fileName
    };
  }

  return null;
}

function joinPathSegments(...parts: string[]): string {
  return parts
    .filter(Boolean)
    .join('/')
    .replace(/\/{2,}/g, '/');
}

function applyPlatformSpecificPaths(
  cwd: string,
  entries: SourceEntry[],
  resolvedInputPath: string,
  options: { inputIsDirectory: boolean; inputIsFile: boolean }
): SourceEntry[] {
  const normalizedInput = resolve(resolvedInputPath);

  for (const entry of entries) {
    const { registryPath, sourcePath } = entry;

    if (isAiRegistryPath(registryPath)) {
      continue;
    }

    const fileName = registryPath.split('/').pop();
    if (fileName && isPlatformRootFile(fileName)) {
      continue;
    }

    const mapping = mapPlatformFileToUniversal(sourcePath);
    if (!mapping) {
      continue;
    }

    const definition = getPlatformDefinition(mapping.platform);
    const subdirDef = definition.subdirs[mapping.subdir];
    if (!subdirDef?.path) {
      continue;
    }

    const subdirAbs = resolve(join(cwd, definition.rootDir, subdirDef.path));
    const sourceAbs = resolve(sourcePath);
    const withinSubdir = sourceAbs === subdirAbs || isWithinDirectory(subdirAbs, sourceAbs);
    if (!withinSubdir) {
      continue;
    }

    if (options.inputIsFile && sourceAbs === normalizedInput) {
      entry.registryPath = suffixFileBasename(registryPath, mapping.platform);
      continue;
    }

    if (!options.inputIsDirectory) {
      continue;
    }

    if (normalizedInput === subdirAbs) {
      entry.registryPath = suffixFileBasename(registryPath, mapping.platform);
      continue;
    }

    if (isWithinDirectory(normalizedInput, sourceAbs)) {
      entry.registryPath = suffixFirstContentDir(registryPath, mapping.platform);
    }
  }

  return entries;
}

function isAiRegistryPath(registryPath: string): boolean {
  return registryPath === PLATFORM_DIRS.AI || registryPath.startsWith(`${PLATFORM_DIRS.AI}/`);
}

// computeDirKeyFromRegistryPath and directory collapsing moved to core/add/package-index-updater.ts

function buildPlatformRootFiles(): Set<string> {
  const rootFiles = new Set<string>();
  for (const platform of getAllPlatforms()) {
    const def = getPlatformDefinition(platform);
    if (def.rootFile) {
      rootFiles.add(def.rootFile);
    }
  }
  rootFiles.add(FILE_PATTERNS.AGENTS_MD);
  return rootFiles;
}

function isPlatformRootFile(fileName: string): boolean {
  return PLATFORM_ROOT_FILES.has(fileName);
}

function isWithinDirectory(parentDir: string, targetPath: string): boolean {
  const resolvedParent = resolve(parentDir);
  const resolvedTarget = resolve(targetPath);

  if (resolvedParent === resolvedTarget) {
    return true;
  }

  const rel = relative(resolvedParent, resolvedTarget);
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel);
}

async function copyWithConflictResolution(
  ensuredPackage: EnsurePackageResult,
  entries: SourceEntry[]
): Promise<PackageFile[]> {
  const changedFiles: PackageFile[] = [];
  const { formulaDir, normalizedName } = ensuredPackage;

  for (const entry of entries) {
    const registryPath = entry.registryPath;
    const destination = join(formulaDir, ...registryPath.split('/'));

    const sourceContent = await readTextFile(entry.sourcePath);
    const destExists = await exists(destination);

    if (destExists) {
      let existingContent = '';
      try {
        existingContent = await readTextFile(destination);
      } catch {
        existingContent = '';
      }

      if (existingContent === sourceContent) {
        logger.debug(`Skipping unchanged file: ${registryPath}`);
        continue;
      }

      const decision = await promptConflictDecision(normalizedName, registryPath);
      if (decision === 'keep-existing') {
        logger.debug(`Kept existing file for ${registryPath}`);
        continue;
      }
    }

    await ensureDir(dirname(destination));
    await writeTextFile(destination, sourceContent);

    changedFiles.push({
      path: registryPath,
      content: sourceContent,
      encoding: 'utf8'
    });
  }

  return changedFiles;
}

async function promptConflictDecision(formulaName: string, registryPath: string): Promise<ConflictDecision> {
  const response = await safePrompts({
    type: 'select',
    name: 'decision',
    message: `File '${registryPath}' already exists in formula '${formulaName}'. Choose how to proceed:`,
    choices: [
      {
        title: 'Keep existing file (skip)',
        value: 'keep-existing'
      },
      {
        title: 'Replace with workspace file',
        value: 'overwrite'
      },
      {
        title: 'Cancel operation',
        value: 'cancel'
      }
    ]
  });

  if (response.decision === 'cancel') {
    throw new UserCancellationError();
  }

  return response.decision as ConflictDecision;
}

async function updatePackageIndex(
  cwd: string,
  ensuredPackage: EnsurePackageResult
): Promise<void> {
  const { normalizedName, formulaDir } = ensuredPackage;
  const formulaFiles = await readLocalPackageFilesForIndex(formulaDir);
  const detectedPlatforms: Platform[] = await getDetectedPlatforms(cwd);
  await buildMappingAndWriteIndex(
    cwd,
    normalizedName,
    formulaFiles,
    detectedPlatforms,
    { preserveExactPaths: true }
  );
}


