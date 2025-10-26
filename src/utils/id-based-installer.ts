/**
 * ID-based Installer
 * Handles installation of platform-specific markdown files using ID-based matching
 * instead of path-based matching, allowing custom file organization in cwd.
 */

import { join, dirname, relative } from 'path';
import { exists, ensureDir, writeTextFile, remove } from './fs.js';
import { logger } from './logger.js';
import { getFirstPathComponent, getPathAfterFirstComponent } from './path-normalization.js';
import { getPlatformDefinition } from '../core/platforms.js';
import { UNIVERSAL_SUBDIRS, PLATFORM_DIRS, type Platform } from '../constants/index.js';
import type { FormulaFile, InstallOptions } from '../types/index.js';
import {
  buildCwdIdMap,
  resolveInstallPathFromAdjacent,
  cleanupInvalidFormulaFiles,
  type RegistryFileInfo,
  CwdIdMapEntry
} from './id-based-discovery.js';
import { getPlatformSpecificFilename, parseUniversalPath } from './platform-file.js';
import { mergePlatformYamlOverride } from './platform-yaml-merge.js';
import { loadRegistryYamlOverrides } from './id-based-discovery.js';
import { rename } from 'fs/promises';

/**
 * Result of ID-based installation
 */
export interface IdBasedInstallResult {
  installed: number;
  updated: number;
  renamed: number;
  cleaned: number;
  deleted: number;
  skipped: number;
  files: string[];
  installedFiles: string[];
  updatedFiles: string[];
}

/**
 * Variant that accepts a pre-discovered registry ID map to avoid duplicate discovery.
 */
export async function installFilesByIdWithMap(
  cwd: string,
  formulaName: string,
  version: string,
  platforms: Platform[],
  registryIdMap: Map<string, RegistryFileInfo>,
  options: InstallOptions,
  forceOverwrite: boolean = false
): Promise<IdBasedInstallResult> {
  const result: IdBasedInstallResult = {
    installed: 0,
    updated: 0,
    renamed: 0,
    cleaned: 0,
    deleted: 0,
    skipped: 0,
    files: [],
    installedFiles: [],
    updatedFiles: []
  };

  logger.debug(`Installing platform files by ID (pre-discovered) for ${formulaName}@${version}`, {
    platforms,
    prediscovered: registryIdMap.size
  });

  // Load YAML overrides once per install (used lazily per platform)
  const yamlOverrides = await loadRegistryYamlOverrides(formulaName, version);

  // Step 1: Build cwd ID map
  const cwdIdMap = await buildCwdIdMap(cwd, platforms, formulaName);

  // Step 3: Clean up invalid files in cwd
  const cleanupResult = await cleanupInvalidFormulaFiles(cwd, platforms, formulaName, registryIdMap);
  result.cleaned = cleanupResult.cleaned.length;
  result.deleted = cleanupResult.deleted.length;

  // Split registry files into AI-scoped and platform-scoped
  const aiFiles: RegistryFileInfo[] = [];
  const nonAiFiles: RegistryFileInfo[] = [];
  for (const [, fileInfo] of registryIdMap) {
    if (fileInfo.parentDir === PLATFORM_DIRS.AI || fileInfo.parentDir.startsWith(PLATFORM_DIRS.AI + '/')) {
      aiFiles.push(fileInfo);
    } else {
      nonAiFiles.push(fileInfo);
    }
  }

  // Process AI files once (not per-platform)
  if (aiFiles.length > 0) {
    const aiFilesByDir = new Map<string, RegistryFileInfo[]>();
    for (const fileInfo of aiFiles) {
      const parentDir = fileInfo.parentDir;
      if (!aiFilesByDir.has(parentDir)) aiFilesByDir.set(parentDir, []);
      aiFilesByDir.get(parentDir)!.push(fileInfo);
    }
    for (const [parentDir, files] of aiFilesByDir) {
      await processBatchOfFilesForAi(
        cwd,
        parentDir,
        files,
        cwdIdMap,
        options,
        result
      );
    }
  }

  // Step 4: Process each platform separately for non-AI files
  for (const platform of platforms) {
    const filesByDir = new Map<string, RegistryFileInfo[]>();
    for (const fileInfo of nonAiFiles) {
      const parentDir = fileInfo.parentDir;
      if (!filesByDir.has(parentDir)) filesByDir.set(parentDir, []);
      filesByDir.get(parentDir)!.push(fileInfo);
    }

    for (const [parentDir, files] of filesByDir) {
      await processBatchOfFilesForPlatform(
        cwd,
        platform,
        parentDir,
        files,
        cwdIdMap,
        options,
        forceOverwrite,
        result,
        yamlOverrides
      );
    }
  }

  logger.info(`ID-based installation (pre-discovered) complete: ${result.installed} installed, ${result.updated} updated, ${result.renamed} renamed, ${result.skipped} skipped`);
  return result;
}

/**
 * Split files into matching (existing ID in scope) and new (fresh) categories
 */
function splitMatchingAndNew(
  files: RegistryFileInfo[],
  cwdIdMap: Map<string, CwdIdMapEntry[]>,
  inScope: (e: CwdIdMapEntry) => boolean
): { matching: RegistryFileInfo[]; fresh: RegistryFileInfo[] } {
  const matching: RegistryFileInfo[] = [];
  const fresh: RegistryFileInfo[] = [];
  for (const file of files) {
    const entries = file.id ? cwdIdMap.get(file.id) : null;
    const exists = entries?.some(inScope) ?? false;
    (file.id && exists ? matching : fresh).push(file);
  }
  return { matching, fresh };
}

/**
 * Update matching entries with new content and optional rename
 */
async function updateMatchingEntries(
  cwd: string,
  registryFile: RegistryFileInfo,
  entries: CwdIdMapEntry[],
  computeTargetFileName: (r: RegistryFileInfo) => string,
  getContent: (r: RegistryFileInfo) => string | Promise<string>,
  canOverwriteRename: boolean,
  options: InstallOptions,
  result: IdBasedInstallResult
): Promise<void> {
  for (const entry of entries) {
    const currentPath = entry.fullPath;
    const currentFileName = entry.fileName;
    const targetFileName = computeTargetFileName(registryFile);
    const needsRename = currentFileName !== targetFileName;
    const targetPath = needsRename ? join(dirname(currentPath), targetFileName) : currentPath;

    if (needsRename && (await exists(targetPath))) {
      if (!(canOverwriteRename || options.force)) {
        logger.warn(`Cannot rename ${currentFileName} to ${targetFileName}: target exists`);
        result.skipped++;
        continue;
      }
      await remove(targetPath);
    }

    try {
      const content = await getContent(registryFile);
      await writeTextFile(currentPath, content);
      if (needsRename) {
        await rename(currentPath, targetPath);
        result.renamed++;
      }
      result.updated++;
      const rel = relative(cwd, targetPath);
      result.files.push(rel);
      result.updatedFiles.push(rel);
    } catch (err) {
      logger.error(`Failed to update file ${currentPath}: ${err}`);
      result.skipped++;
    }
  }
}

/**
 * Collect all adjacent IDs from a list of files (excluding each file's own ID)
 */
function collectAdjacentIds(files: RegistryFileInfo[]): string[] {
  const s = new Set<string>();
  for (const f of files) for (const id of f.adjacentIds) if (id !== f.id) s.add(id);
  return Array.from(s);
}

/**
 * Resolve fallback target directory for a given scope (AI or platform)
 */
async function resolveTargetDirForScope(
  cwd: string,
  registryParentDir: string,
  scope: 'ai' | Platform
): Promise<string | null> {
  if (scope === PLATFORM_DIRS.AI) {
    const relAfterAi =
      registryParentDir === PLATFORM_DIRS.AI
        ? ''
        : registryParentDir.startsWith(PLATFORM_DIRS.AI + '/')
          ? registryParentDir.slice(PLATFORM_DIRS.AI.length + 1)
          : registryParentDir;
    return relAfterAi ? join(cwd, PLATFORM_DIRS.AI, relAfterAi) : join(cwd, PLATFORM_DIRS.AI);
  }
  return mapRegistryPathToCwd(cwd, [scope], registryParentDir);
}

/**
 * Generic installer for new files with injected behavior
 */
async function installNewFilesGeneric(
  cwd: string,
  registryParentDir: string,
  files: RegistryFileInfo[],
  cwdIdMap: Map<string, CwdIdMapEntry[]>,
  resolveFallbackDir: (cwd: string, parentDir: string) => Promise<string | null>,
  getFileName: (f: RegistryFileInfo) => string,
  getContent: (f: RegistryFileInfo) => string | Promise<string>,
  options: InstallOptions,
  result: IdBasedInstallResult
): Promise<void> {
  const resolvedDir = await resolveInstallPathFromAdjacent(collectAdjacentIds(files), cwdIdMap);
  const targetDir = resolvedDir ?? (await resolveFallbackDir(cwd, registryParentDir));
  if (!targetDir) return;

  for (const file of files) {
    const fileName = getFileName(file);
    const targetPath = join(targetDir, fileName);

    if (await exists(targetPath)) {
      if (!options.force) {
        console.log(`Skipping ${fileName} - already exists at ${targetPath}`);
        result.skipped++;
        continue;
      }
    }

    try {
      await ensureDir(targetDir);
      const content = await getContent(file);
      await writeTextFile(targetPath, content);
      result.installed++;
      const rel = relative(cwd, targetPath);
      result.files.push(rel);
      result.installedFiles.push(rel);
    } catch (e) {
      logger.error(`Failed to install ${fileName}: ${e}`);
      result.skipped++;
    }
  }
}

/**
 * Process a batch of files from the same parent directory in the registry for a specific platform
 */
async function processBatchOfFilesForPlatform(
  cwd: string,
  platform: Platform,
  parentDir: string,
  files: RegistryFileInfo[],
  cwdIdMap: Map<string, CwdIdMapEntry[]>,
  options: InstallOptions,
  forceOverwrite: boolean,
  result: IdBasedInstallResult,
  yamlOverrides: FormulaFile[]
): Promise<void> {
  const { matching, fresh } = splitMatchingAndNew(files, cwdIdMap, e => e.platform === platform);

  for (const file of matching) {
    const entries = (file.id ? cwdIdMap.get(file.id) : [])?.filter(e => e.platform === platform) ?? [];
    await updateMatchingEntries(
      cwd,
      file,
      entries,
      r => getPlatformSpecificFilename(r.registryPath, platform),
      r => {
        const parsed = parseUniversalPath(r.registryPath);
        return parsed
          ? mergePlatformYamlOverride(r.content, platform, parsed.universalSubdir, parsed.relPath, yamlOverrides)
          : r.content;
      },
      /* canOverwriteRename */ forceOverwrite,
      options,
      result
    );
  }

  if (fresh.length > 0) {
    await installNewFilesGeneric(
      cwd,
      parentDir,
      fresh,
      cwdIdMap,
      (cwd2, parent) => mapRegistryPathToCwd(cwd2, [platform], parent),
      f => getPlatformSpecificFilename(f.registryPath, platform),
      f => {
        const parsed = parseUniversalPath(f.registryPath);
        return parsed
          ? mergePlatformYamlOverride(f.content, platform, parsed.universalSubdir, parsed.relPath, yamlOverrides)
          : f.content;
      },
      options,
      result
    );
  }
}


/**
 * Map a registry parent directory path to a cwd platform directory
 * E.g., "rules/subdir" → ".cursor/rules/subdir" (for first available platform)
 * Returns null if the platform doesn't support the universal subdirectory
 */
async function mapRegistryPathToCwd(
  cwd: string,
  platforms: Platform[],
  registryParentDir: string
): Promise<string | null> {
  // Extract the universal subdir and relative path
  const universalSubdir = getFirstPathComponent(registryParentDir) as typeof UNIVERSAL_SUBDIRS[keyof typeof UNIVERSAL_SUBDIRS];
  const relativePath = getPathAfterFirstComponent(registryParentDir);

  // Use the first platform to determine the target directory
  const platform = platforms[0];
  const platformDef = getPlatformDefinition(platform);
  const subdirDef = platformDef.subdirs[universalSubdir];

  if (!subdirDef) {
    // Platform doesn't support this universal subdirectory
    return null;
  }

  const baseDir = join(cwd, platformDef.rootDir, subdirDef.path);
  return relativePath ? join(baseDir, relativePath) : baseDir;
}

/**
 * Process a batch of AI files from the same parent directory in the registry
 */
async function processBatchOfFilesForAi(
  cwd: string,
  parentDir: string,
  files: RegistryFileInfo[],
  cwdIdMap: Map<string, CwdIdMapEntry[]>,
  options: InstallOptions,
  result: IdBasedInstallResult
): Promise<void> {
  const { matching, fresh } = splitMatchingAndNew(files, cwdIdMap, e => e.platform === PLATFORM_DIRS.AI);

  for (const file of matching) {
    const entries = (file.id ? cwdIdMap.get(file.id) : [])?.filter(e => e.platform === PLATFORM_DIRS.AI) ?? [];
    await updateMatchingEntries(
      cwd,
      file,
      entries,
      r => r.fileName,
      r => r.content,
      /* canOverwriteRename */ false,
      options,
      result
    );
  }

  if (fresh.length > 0) {
    await installNewFilesGeneric(
      cwd,
      parentDir,
      fresh,
      cwdIdMap,
      (cwd2, parent) => resolveTargetDirForScope(cwd2, parent, PLATFORM_DIRS.AI),
      f => f.fileName,
      f => f.content,
      options,
      result
    );
  }
}


