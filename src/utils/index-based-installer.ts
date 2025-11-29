import { dirname, join, relative, parse as parsePath, sep } from 'path';
import { promises as fs } from 'fs';

import {
  exists,
  ensureDir,
  listDirectories,
  listFiles,
  remove,
  removeEmptyDirectories,
  walkFiles
} from './fs.js';
import { writeIfChanged } from '../core/install/file-updater.js';
import { getLocalPackagesDir } from './paths.js';
import { packageManager } from '../core/package.js';
import { logger } from './logger.js';
import {
  DIR_PATTERNS,
  FILE_PATTERNS,
  UNIVERSAL_SUBDIRS
} from '../constants/index.js';
import type { Platform } from '../core/platforms.js';
import { getFirstPathComponent, getPathAfterFirstComponent, normalizePathForProcessing } from './path-normalization.js';
import {
  isAllowedRegistryPath,
  isRootRegistryPath,
  isSkippableRegistryPath,
  normalizeRegistryPath
} from './registry-entry-filter.js';
import { mapUniversalToPlatform } from './platform-mapper.js';
import { safePrompts } from './prompts.js';
import type { InstallOptions } from '../types/index.js';
import type { PackageFile } from '../types/index.js';
import { mergePlatformYamlOverride, loadRegistryYamlOverrides } from './platform-yaml-merge.js';
import { parseUniversalPath } from './platform-file.js';
import { getPlatformDefinition } from '../core/platforms.js';

import {
  PACKAGE_INDEX_FILENAME,
  getPackageIndexPath,
  readPackageIndex,
  writePackageIndex,
  sortMapping,
  ensureTrailingSlash,
  isDirKey,
  type PackageIndexRecord,
  pruneNestedDirectories
} from './package-index-yml.js';
import { createWorkspaceHash } from './version-generator.js';

// ============================================================================
// Types and Interfaces
// ============================================================================

type UniversalSubdir = typeof UNIVERSAL_SUBDIRS[keyof typeof UNIVERSAL_SUBDIRS];

interface RegistryFileEntry {
  registryPath: string;
  content: string;
  encoding?: string;
}

interface PlannedTarget {
  absPath: string;
  relPath: string;
  platform?: Platform | 'ai' | 'other';
}

interface PlannedFile {
  registryPath: string;
  content: string;
  encoding?: string;
  targets: PlannedTarget[];
}

interface GroupPlan {
  key: string;
  plannedFiles: PlannedFile[];
  decision: 'dir' | 'file';
  platformDecisions: Map<Platform | 'ai' | 'other', 'dir' | 'file'>;
  targetDirs: Set<string>;
}

interface ConflictOwner {
  packageName: string;
  key: string;
  type: 'file' | 'dir';
  indexPath: string;
}

interface ExpandedIndexesContext {
  dirKeyOwners: Map<string, ConflictOwner[]>;
  installedPathOwners: Map<string, ConflictOwner>;
}

type ConflictResolution = 'keep-both' | 'skip' | 'overwrite';

export interface PlannedConflict {
  relPath: string;
  reason: 'owned-by-other' | 'exists-unowned';
  ownerPackage?: string;
}

interface PlannedTargetDetail {
  absPath: string;
  relPath: string;
  content: string;
  encoding?: string;
}

// ============================================================================
// Conflict Planning Functions
// ============================================================================

export async function planConflictsForPackage(
  cwd: string,
  packageName: string,
  version: string,
  platforms: Platform[]
): Promise<PlannedConflict[]> {
  const registryEntries = await loadRegistryFileEntries(packageName, version);
  const plannedFiles = createPlannedFiles(registryEntries);
  attachTargetsToPlannedFiles(cwd, plannedFiles, platforms);

  const otherIndexes = await loadOtherPackageIndexes(cwd, packageName);
  const context = await buildExpandedIndexesContext(cwd, otherIndexes);
  const previousIndex = await readPackageIndex(cwd, packageName);
  const previousOwnedPaths = await expandIndexToFilePaths(cwd, previousIndex);

  const conflicts: PlannedConflict[] = [];
  const seen = new Set<string>();

  for (const planned of plannedFiles) {
    for (const target of planned.targets) {
      const normalizedRel = normalizePathForProcessing(target.relPath);
      if (seen.has(normalizedRel)) {
        continue;
      }

      const owner = context.installedPathOwners.get(normalizedRel);
      if (owner) {
        conflicts.push({
          relPath: normalizedRel,
          reason: 'owned-by-other',
          ownerPackage: owner.packageName
        });
        seen.add(normalizedRel);
        continue;
      }

      if (!previousOwnedPaths.has(normalizedRel)) {
        const absTarget = join(cwd, normalizedRel);
        if (await exists(absTarget)) {
          conflicts.push({
            relPath: normalizedRel,
            reason: 'exists-unowned'
          });
          seen.add(normalizedRel);
        }
      }
    }
  }

  return conflicts.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

// ============================================================================
// Conflict Resolution Functions
// ============================================================================

async function generateLocalPath(cwd: string, relPath: string): Promise<string> {
  const parsed = parsePath(relPath);
  const directory = parsed.dir ? parsed.dir.replace(/\\/g, '/') : '';
  
  // Try .local first
  let baseName = `${parsed.name}.local${parsed.ext}`;
  let candidate = directory ? `${directory}/${baseName}` : baseName;
  let absCandidate = join(cwd, candidate);
  
  if (!(await exists(absCandidate))) {
    return normalizePathForProcessing(candidate);
  }
  
  // Try .local-1, .local-2, etc.
  let increment = 1;
  while (true) {
    baseName = `${parsed.name}.local-${increment}${parsed.ext}`;
    candidate = directory ? `${directory}/${baseName}` : baseName;
    absCandidate = join(cwd, candidate);
    
    if (!(await exists(absCandidate))) {
      return normalizePathForProcessing(candidate);
    }
    
    increment++;
  }
}

async function promptConflictResolution(
  message: string
): Promise<ConflictResolution> {
  const response = await safePrompts({
    type: 'select',
    name: 'choice',
    message,
    choices: [
      {
        title: 'Keep both (renames existing)',
        value: 'keep-both'
      },
      {
        title: 'Skip (keeps existing)',
        value: 'skip'
      },
      {
        title: 'Overwrite (replaces existing)',
        value: 'overwrite'
      }
    ]
  });

  const choice = (response as any).choice as ConflictResolution | undefined;
  return choice ?? 'skip';
}

async function updateOwnerIndexAfterRename(
  owner: ConflictOwner,
  oldRelPath: string,
  newRelPath: string,
  indexByPackage: Map<string, PackageIndexRecord>
): Promise<void> {
  const normalizedOld = normalizePathForProcessing(oldRelPath);
  const normalizedNew = normalizePathForProcessing(newRelPath);
  const record = indexByPackage.get(owner.packageName);
  if (!record) return;

  if (owner.type === 'file') {
    const values = record.files[owner.key];
    if (!values) return;
    const idx = values.findIndex(value => normalizePathForProcessing(value) === normalizedOld);
    if (idx === -1) return;
    values[idx] = normalizedNew;
    await writePackageIndex(record);
  } else {
    // Directory key still valid; nothing to change.
  }
}

async function resolveConflictsForPlannedFiles(
  cwd: string,
  plannedFiles: PlannedFile[],
  context: ExpandedIndexesContext,
  otherIndexes: PackageIndexRecord[],
  previousOwnedPaths: Set<string>,
  options: InstallOptions
): Promise<string[]> {
  const warnings: string[] = [];
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const isDryRun = Boolean(options.dryRun);
  const defaultStrategy = options.conflictStrategy;
  const perPathDecisions = new Map<string, ConflictResolution>();
  if (options.conflictDecisions) {
    for (const [rawPath, decision] of Object.entries(options.conflictDecisions)) {
      perPathDecisions.set(normalizePathForProcessing(rawPath), decision as ConflictResolution);
    }
  }
  const indexByPackage = new Map<string, PackageIndexRecord>();
  for (const record of otherIndexes) {
    indexByPackage.set(record.packageName, record);
  }

  for (const planned of plannedFiles) {
    const filteredTargets: PlannedTarget[] = [];

    for (const target of planned.targets) {
      const normalizedRel = normalizePathForProcessing(target.relPath);
      const absTarget = join(cwd, normalizedRel);
      const owner = context.installedPathOwners.get(normalizedRel);

      if (owner) {
        let decision: ConflictResolution | undefined = perPathDecisions.get(normalizedRel);

        if (!decision) {
          if (options.force) {
            decision = 'keep-both';
          } else if (defaultStrategy && defaultStrategy !== 'ask') {
            decision = defaultStrategy as ConflictResolution;
            if (decision === 'skip') {
              warnings.push(`Skipping ${normalizedRel} (owned by ${owner.packageName}) due to configured conflict strategy.`);
            }
          } else if (!interactive) {
            warnings.push(`Skipping ${normalizedRel} (owned by ${owner.packageName}) due to non-interactive conflict.`);
            decision = 'skip';
          } else {
            decision = await promptConflictResolution(
              `File ${normalizedRel} is managed by package ${owner.packageName}. How would you like to proceed?`
            );
          }
        }

        if (decision === 'skip') {
          continue;
        }

        if (decision === 'keep-both') {
          if (isDryRun) {
            const localPath = await generateLocalPath(cwd, normalizedRel);
            warnings.push(`Would rename existing ${normalizedRel} from ${owner.packageName} to ${localPath} and install new file at ${normalizedRel}.`);
            filteredTargets.push(target);
            continue;
          }

          const localRelPath = await generateLocalPath(cwd, normalizedRel);
          const absLocalPath = join(cwd, localRelPath);
          await ensureDir(dirname(absLocalPath));
          try {
            await fs.rename(absTarget, absLocalPath);
            await updateOwnerIndexAfterRename(owner, normalizedRel, localRelPath, indexByPackage);
            context.installedPathOwners.delete(normalizedRel);
            context.installedPathOwners.set(normalizePathForProcessing(localRelPath), owner);
            warnings.push(`Renamed existing ${normalizedRel} from ${owner.packageName} to ${localRelPath}.`);
            filteredTargets.push(target);
          } catch (error) {
            warnings.push(`Failed to rename ${normalizedRel}: ${error}`);
          }
          continue;
        }

        // overwrite
        if (isDryRun) {
          warnings.push(`Would overwrite ${normalizedRel} (currently from ${owner.packageName}).`);
          filteredTargets.push(target);
          continue;
        }

        // Clear in-memory owner mapping to avoid repeated prompts this run
        context.installedPathOwners.delete(normalizedRel);
        filteredTargets.push(target);
        continue;
      }

      if (!previousOwnedPaths.has(normalizedRel) && (await exists(absTarget))) {
        let decision: ConflictResolution | undefined = perPathDecisions.get(normalizedRel);

        if (!decision) {
          if (options.force) {
            decision = 'keep-both';
          } else if (defaultStrategy && defaultStrategy !== 'ask') {
            decision = defaultStrategy as ConflictResolution;
            if (decision === 'skip') {
              warnings.push(`Skipping ${normalizedRel} because it already exists (configured conflict strategy).`);
            }
          } else if (!interactive) {
            warnings.push(`Skipping ${normalizedRel} because it already exists and cannot prompt in non-interactive mode.`);
            decision = 'skip';
          } else {
            decision = await promptConflictResolution(
              `File ${normalizedRel} already exists in your project. How would you like to proceed?`
            );
          }
        }

        if (decision === 'skip') {
          continue;
        }

        if (decision === 'keep-both') {
          if (isDryRun) {
            const localPath = await generateLocalPath(cwd, normalizedRel);
            warnings.push(`Would rename existing local file ${normalizedRel} to ${localPath} and install new file at ${normalizedRel}.`);
            filteredTargets.push(target);
            continue;
          }

          const localRelPath = await generateLocalPath(cwd, normalizedRel);
          const absLocalPath = join(cwd, localRelPath);
          await ensureDir(dirname(absLocalPath));
          try {
            await fs.rename(absTarget, absLocalPath);
            warnings.push(`Renamed existing local file ${normalizedRel} to ${localRelPath}.`);
            filteredTargets.push(target);
          } catch (error) {
            warnings.push(`Failed to rename existing local file ${normalizedRel}: ${error}`);
          }
          continue;
        }

        // overwrite
        if (isDryRun) {
          warnings.push(`Would overwrite existing local file ${normalizedRel}.`);
          filteredTargets.push(target);
          continue;
        }

        filteredTargets.push(target);
        continue;
      }

      filteredTargets.push(target);
    }

    planned.targets = filteredTargets;
  }

  return warnings;
}


export interface IndexInstallResult {
  installed: number;
  updated: number;
  deleted: number;
  skipped: number;
  files: string[];
  installedFiles: string[];
  updatedFiles: string[];
  deletedFiles: string[];
}

// ============================================================================
// Path and File Utilities
// ============================================================================

function normalizeRelativePath(cwd: string, absPath: string): string {
  const rel = relative(cwd, absPath);
  const normalized = normalizePathForProcessing(rel);
  return normalized.replace(/\\/g, '/');
}

async function collectPackageDirectories(
  cwd: string
): Promise<Array<{ packageName: string; dir: string }>> {
  const packagesRoot = getLocalPackagesDir(cwd);
  if (!(await exists(packagesRoot))) {
    return [];
  }

  const results: Array<{ packageName: string; dir: string }> = [];

  async function recurse(currentDir: string, relativeBase: string): Promise<void> {
    const packageYmlPath = join(currentDir, FILE_PATTERNS.PACKAGE_YML);
    if (await exists(packageYmlPath)) {
      const packageName = relativeBase.replace(new RegExp(`\\${sep}`, 'g'), '/');
      results.push({ packageName, dir: currentDir });
      return;
    }

    const subdirs = await listDirectories(currentDir).catch(() => [] as string[]);
    for (const subdir of subdirs) {
      const nextDir = join(currentDir, subdir);
      const nextRelative = relativeBase ? `${relativeBase}${sep}${subdir}` : subdir;
      await recurse(nextDir, nextRelative);
    }
  }

  const topLevelDirs = await listDirectories(packagesRoot).catch(() => [] as string[]);
  for (const dir of topLevelDirs) {
    const absolute = join(packagesRoot, dir);
    await recurse(absolute, dir);
  }

  return results;
}

export async function loadOtherPackageIndexes(
  cwd: string,
  excludePackage: string
): Promise<PackageIndexRecord[]> {
  const directories = await collectPackageDirectories(cwd);
  const results: PackageIndexRecord[] = [];

  for (const entry of directories) {
    if (entry.packageName === excludePackage) continue;
    const indexPath = join(entry.dir, PACKAGE_INDEX_FILENAME);
    if (!(await exists(indexPath))) continue;

    const record = await readPackageIndex(cwd, entry.packageName);
    if (record) {
      record.path = indexPath;
      results.push(record);
    }
  }

  return results;
}

async function collectFilesUnderDirectory(cwd: string, dirRel: string): Promise<string[]> {
  const directoryRel = ensureTrailingSlash(normalizePathForProcessing(dirRel));
  const absDir = join(cwd, directoryRel);
  if (!(await exists(absDir))) {
    return [];
  }

  const collected: string[] = [];
  try {
    for await (const absFile of walkFiles(absDir)) {
      const relPath = normalizeRelativePath(cwd, absFile);
      collected.push(relPath);
    }
  } catch (error) {
    logger.warn(`Failed to enumerate directory ${absDir}: ${error}`);
  }
  return collected;
}

async function buildExpandedIndexesContext(
  cwd: string,
  indexes: PackageIndexRecord[]
): Promise<ExpandedIndexesContext> {
  const dirKeyOwners = new Map<string, ConflictOwner[]>();
  const installedPathOwners = new Map<string, ConflictOwner>();

  for (const record of indexes) {
    for (const [rawKey, values] of Object.entries(record.files)) {
      const key = normalizePathForProcessing(rawKey);
      const owner: ConflictOwner = {
        packageName: record.packageName,
        key,
        type: key.endsWith('/') ? 'dir' : 'file',
        indexPath: record.path
      };

      if (owner.type === 'dir') {
        if (!dirKeyOwners.has(key)) {
          dirKeyOwners.set(key, []);
        }
        dirKeyOwners.get(key)!.push(owner);

        for (const dirRel of values) {
          const files = await collectFilesUnderDirectory(cwd, dirRel);
          for (const filePath of files) {
            if (!installedPathOwners.has(filePath)) {
              installedPathOwners.set(filePath, owner);
            }
          }
        }
      } else {
        for (const fileRel of values) {
          const normalizedValue = normalizePathForProcessing(fileRel);
          if (!installedPathOwners.has(normalizedValue)) {
            installedPathOwners.set(normalizedValue, owner);
          }
        }
      }
    }
  }

  return { dirKeyOwners, installedPathOwners };
}

// ============================================================================
// Registry File Loading Functions
// ============================================================================

async function loadRegistryFileEntries(
  packageName: string,
  version: string
): Promise<RegistryFileEntry[]> {
  const pkg = await packageManager.loadPackage(packageName, version);
  const entries: RegistryFileEntry[] = [];

  for (const file of pkg.files) {
    const normalized = normalizeRegistryPath(file.path);

    // Skip root files - these are handled by installRootFilesFromMap
    if (isRootRegistryPath(normalized)) {
      continue;
    }

    if (!isAllowedRegistryPath(normalized)) {
      // Ignore any other top-level paths (e.g., README.md, some/...)
      continue;
    }

    entries.push({
      registryPath: normalized,
      content: file.content,
      encoding: (file.encoding as string | undefined) ?? 'utf8'
    });
  }

  return entries;
}

function deriveGroupKey(registryPath: string): string {
  const normalized = normalizeRegistryPath(registryPath);
  const segments = normalized.split('/');
  if (segments.length <= 1) {
    return '';
  }

  const first = segments[0];
  const universalValues = Object.values(UNIVERSAL_SUBDIRS) as string[];

  if (first === DIR_PATTERNS.AI) {
    if (segments.length >= 2) {
      return ensureTrailingSlash(`${segments[0]}/${segments[1]}`);
    }
    return ensureTrailingSlash(`${segments[0]}`);
  }

  if (universalValues.includes(first)) {
    if (segments.length >= 2) {
      return ensureTrailingSlash(`${segments[0]}/${segments[1]}`);
    }
    return ensureTrailingSlash(`${segments[0]}`);
  }

  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash === -1) return '';
  return ensureTrailingSlash(normalized.substring(0, lastSlash));
}

function createPlannedFiles(entries: RegistryFileEntry[]): PlannedFile[] {
  return entries.map(entry => ({
    registryPath: entry.registryPath,
    content: entry.content,
    encoding: entry.encoding,
    targets: []
  }));
}

function groupPlannedFiles(plannedFiles: PlannedFile[]): Map<string, PlannedFile[]> {
  const groups = new Map<string, PlannedFile[]>();
  for (const planned of plannedFiles) {
    const key = deriveGroupKey(planned.registryPath);
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(planned);
  }
  return groups;
}

// ============================================================================
// Planning Functions
// ============================================================================

function buildPlannedTargetMap(plannedFiles: PlannedFile[], yamlOverrides: PackageFile[]): Map<string, PlannedTargetDetail> {
  const map = new Map<string, PlannedTargetDetail>();

  type PlannedWithParsed = { planned: PlannedFile; parsed: ReturnType<typeof parseUniversalPath> };
  const universalPlanned: PlannedWithParsed[] = [];
  const platformSuffixedPlanned: PlannedWithParsed[] = [];

  for (const planned of plannedFiles) {
    const parsed = parseUniversalPath(planned.registryPath);
    if (parsed?.platformSuffix) {
      platformSuffixedPlanned.push({ planned, parsed });
    } else {
      universalPlanned.push({ planned, parsed });
    }
  }

  const applyPlanned = (entries: PlannedWithParsed[]) => {
    for (const { planned, parsed } of entries) {
      for (const target of planned.targets) {
        const normalizedRel = normalizePathForProcessing(target.relPath);

        // Compute per-target content (apply platform YAML overrides for universal files)
        let content = planned.content;
        if (parsed && target.platform && target.platform !== 'ai' && target.platform !== 'other') {
          content = mergePlatformYamlOverride(
            planned.content,
            target.platform as Platform,
            parsed.universalSubdir,
            parsed.relPath,
            yamlOverrides
          );
        }

        map.set(normalizedRel, {
          absPath: target.absPath,
          relPath: normalizedRel,
          content,
          encoding: planned.encoding
        });
      }
    }
  };

  // Apply universal files first, then platform-suffixed files so platform-specific content wins when targets overlap.
  applyPlanned(universalPlanned);
  applyPlanned(platformSuffixedPlanned);

  return map;
}

function computeDiff(
  plannedMap: Map<string, PlannedTargetDetail>,
  previousOwnedPaths: Set<string>
): { planned: Map<string, PlannedTargetDetail>; deletions: string[] } {
  const deletions: string[] = [];
  for (const rel of previousOwnedPaths) {
    if (!plannedMap.has(rel)) {
      deletions.push(rel);
    }
  }
  return { planned: plannedMap, deletions };
}

async function applyFileOperations(
  cwd: string,
  planned: Map<string, PlannedTargetDetail>,
  deletions: string[],
  options: InstallOptions
): Promise<IndexInstallResult> {
  const result: IndexInstallResult = {
    installed: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    files: [],
    installedFiles: [],
    updatedFiles: [],
    deletedFiles: []
  };

  const isDryRun = Boolean(options.dryRun);
  const touched = new Set<string>();

  for (const rel of deletions) {
    const absPath = join(cwd, rel);
    if (isDryRun) {
      result.skipped++;
      continue;
    }
    try {
      await remove(absPath);
      result.deleted++;
      result.deletedFiles.push(rel);
      touched.add(rel);
    } catch (error) {
      logger.warn(`Failed to remove ${absPath}: ${error}`);
      result.skipped++;
    }
  }

  for (const [rel, detail] of planned.entries()) {
    const absPath = detail.absPath;
    if (isDryRun) {
      result.skipped++;
      continue;
    }

    try {
      await ensureDir(dirname(absPath));
      const outcome = await writeIfChanged(absPath, detail.content);
      if (outcome === 'created') {
        result.installed++;
        result.installedFiles.push(rel);
        touched.add(rel);
      } else if (outcome === 'updated') {
        result.updated++;
        result.updatedFiles.push(rel);
        touched.add(rel);
      } else {
        touched.add(rel);
      }
    } catch (error) {
      logger.error(`Failed to write ${absPath}: ${error}`);
      result.skipped++;
    }
  }

  if (!isDryRun) {
    const directories = new Set<string>();
    for (const rel of deletions) {
      const dirRel = dirname(rel);
      if (dirRel && dirRel !== '.') {
        directories.add(dirRel);
      }
    }
    for (const dirRel of directories) {
      const absDir = join(cwd, dirRel);
      await removeEmptyDirectories(absDir).catch(() => undefined);
      if (!(await directoryHasEntries(absDir))) {
        await remove(absDir).catch(() => undefined);
      }
    }
  }

  result.files = Array.from(touched).sort();
  return result;
}

// ============================================================================
// Index Mapping Building Functions
// ============================================================================

function refreshGroupTargetDirs(plan: GroupPlan): void {
  plan.targetDirs = collectTargetDirectories(plan.plannedFiles);
}

interface SeparatedTargets {
  dirTargets: PlannedTarget[];
  fileTargetsByRegistryPath: Map<string, PlannedTarget[]>;
}

function separateTargetsByPlatformDecision(plan: GroupPlan): SeparatedTargets {
  const dirTargets: PlannedTarget[] = [];
  const fileTargetsByRegistryPath = new Map<string, PlannedTarget[]>();

  for (const file of plan.plannedFiles) {
    const registryPath = normalizeRegistryPath(file.registryPath);
    for (const target of file.targets) {
      const platform = target.platform ?? 'other';
      const platformDecision = plan.platformDecisions.get(platform) ?? plan.decision;
      
      if (platformDecision === 'dir') {
        dirTargets.push(target);
      } else {
        if (!fileTargetsByRegistryPath.has(registryPath)) {
          fileTargetsByRegistryPath.set(registryPath, []);
        }
        fileTargetsByRegistryPath.get(registryPath)!.push(target);
      }
    }
  }

  return { dirTargets, fileTargetsByRegistryPath };
}

function buildDirKeyMapping(
  plan: GroupPlan,
  dirTargets: PlannedTarget[]
): Record<string, string[]> {
  const mapping: Record<string, string[]> = {};
  
  if (dirTargets.length === 0 || plan.decision !== 'dir') {
    return mapping;
  }

  const dirsForDirKey = new Set<string>();
  for (const target of dirTargets) {
    const dirName = dirname(target.relPath);
    if (dirName && dirName !== '.') {
      dirsForDirKey.add(ensureTrailingSlash(normalizePathForProcessing(dirName)));
    }
  }

  if (dirsForDirKey.size > 0) {
    const key = ensureTrailingSlash(plan.key);
    const pruned = pruneNestedDirectories(Array.from(dirsForDirKey));
    const values = pruned.map(dir => ensureTrailingSlash(dir)).sort();
    mapping[key] = values;
  }

  return mapping;
}

function buildFileMappings(
  fileTargetsByRegistryPath: Map<string, PlannedTarget[]>
): Record<string, string[]> {
  const mapping: Record<string, string[]> = {};

  for (const [registryPath, targets] of fileTargetsByRegistryPath.entries()) {
    const values = Array.from(
      new Set(
        targets.map(target => normalizePathForProcessing(target.relPath))
      )
    ).sort();
    mapping[registryPath] = values;
  }

  return mapping;
}

function buildFallbackFileMappings(plan: GroupPlan): Record<string, string[]> {
  const mapping: Record<string, string[]> = {};

  for (const file of plan.plannedFiles) {
    if (file.targets.length === 0) continue;
    const values = Array.from(
      new Set(
        file.targets.map(target => normalizePathForProcessing(target.relPath))
      )
    ).sort();
    mapping[normalizeRegistryPath(file.registryPath)] = values;
  }

  return mapping;
}

function buildIndexMappingFromPlans(plans: GroupPlan[]): Record<string, string[]> {
  const mapping: Record<string, string[]> = {};

  for (const plan of plans) {
    refreshGroupTargetDirs(plan);
    const fileMappings = buildFallbackFileMappings(plan);
    for (const [registryPath, values] of Object.entries(fileMappings)) {
      const existing = mapping[registryPath] ?? [];
      mapping[registryPath] = Array.from(new Set([...existing, ...values]));
    }
  }

  return sortMapping(mapping);
}

// ============================================================================
// Main Install Function
// ============================================================================

export async function installPackageByIndex(
  cwd: string,
  packageName: string,
  version: string,
  platforms: Platform[],
  options: InstallOptions
): Promise<IndexInstallResult> {
  const registryEntries = await loadRegistryFileEntries(packageName, version);

  const plannedFiles = createPlannedFiles(registryEntries);
  attachTargetsToPlannedFiles(cwd, plannedFiles, platforms);

  const groups = groupPlannedFiles(plannedFiles);
  const previousIndex = await readPackageIndex(cwd, packageName);
  const otherIndexes = await loadOtherPackageIndexes(cwd, packageName);
  const context = await buildExpandedIndexesContext(cwd, otherIndexes);
  const groupPlans = await decideGroupPlans(cwd, groups, previousIndex, context);
  const previousOwnedPaths = await expandIndexToFilePaths(cwd, previousIndex);

  const conflictWarnings = await resolveConflictsForPlannedFiles(
    cwd,
    plannedFiles,
    context,
    otherIndexes,
    previousOwnedPaths,
    options
  );
  for (const warning of conflictWarnings) {
    logger.warn(warning);
  }

  // Load platform YAML overrides once per install
  const yamlOverrides = await loadRegistryYamlOverrides(packageName, version);

  const plannedTargetMap = buildPlannedTargetMap(plannedFiles, yamlOverrides);
  const { planned, deletions } = computeDiff(plannedTargetMap, previousOwnedPaths);

  const operationResult = await applyFileOperations(cwd, planned, deletions, options);

  if (!options.dryRun) {
    const mapping = buildIndexMappingFromPlans(groupPlans);
    const workspaceHash = previousIndex?.workspace?.hash ?? createWorkspaceHash(cwd);
    const indexRecord: PackageIndexRecord = {
      path: getPackageIndexPath(cwd, packageName),
      packageName,
      workspace: {
        hash: workspaceHash,
        version
      },
      files: mapping
    };
    await writePackageIndex(indexRecord);
  }

  return operationResult;
}





// ============================================================================
// Target Mapping Functions
// ============================================================================

async function expandIndexToFilePaths(
  cwd: string,
  index: PackageIndexRecord | null
): Promise<Set<string>> {
  const owned = new Set<string>();
  if (!index) return owned;

  for (const [key, values] of Object.entries(index.files)) {
    if (isDirKey(key)) {
      for (const dirRel of values) {
        const files = await collectFilesUnderDirectory(cwd, dirRel);
        for (const rel of files) {
          owned.add(normalizePathForProcessing(rel));
        }
      }
    } else {
      for (const value of values) {
        owned.add(normalizePathForProcessing(value));
      }
    }
  }

  return owned;
}


function mapRegistryPathToTargets(
  cwd: string,
  registryPath: string,
  platforms: Platform[]
): PlannedTarget[] {
  const normalized = normalizeRegistryPath(registryPath);
  const first = getFirstPathComponent(normalized);
  const targets: PlannedTarget[] = [];

  const universalValues = Object.values(UNIVERSAL_SUBDIRS) as string[];

  if (first === DIR_PATTERNS.AI) {
    const targetAbs = join(cwd, normalized);
    targets.push({
      absPath: targetAbs,
      relPath: normalizeRelativePath(cwd, targetAbs),
      platform: 'ai'
    });
    return targets;
  }

  if (universalValues.includes(first)) {
    // Parse the universal path to detect platform suffix and normalized relative path
    const parsed = parseUniversalPath(normalized);

    // If a platform suffix is present, only target that specific platform and drop the suffix for install path
    if (parsed?.platformSuffix) {
      const targetPlatform = parsed.platformSuffix as Platform;
      if (platforms.includes(targetPlatform)) {
        try {
          const mapped = mapUniversalToPlatform(
            targetPlatform,
            parsed.universalSubdir as UniversalSubdir,
            parsed.relPath
          );
          const targetAbs = join(cwd, mapped.absFile);
          targets.push({
            absPath: targetAbs,
            relPath: normalizeRelativePath(cwd, targetAbs),
            platform: targetPlatform
          });
        } catch (error) {
          logger.debug(`Platform ${targetPlatform} does not support ${normalized}: ${error}`);
        }
      }
      return targets;
    }

    // No platform suffix: map to all detected/selected platforms
    const rel = parsed ? parsed.relPath : getPathAfterFirstComponent(normalized);
    for (const platform of platforms) {
      try {
        const mapped = mapUniversalToPlatform(platform, first as UniversalSubdir, rel);
        const targetAbs = join(cwd, mapped.absFile);
        targets.push({
          absPath: targetAbs,
          relPath: normalizeRelativePath(cwd, targetAbs),
          platform
        });
      } catch (error) {
        logger.debug(`Platform ${platform} does not support ${normalized}: ${error}`);
      }
    }
    return targets;
  }

  const fallbackAbs = join(cwd, normalized);
  targets.push({
    absPath: fallbackAbs,
    relPath: normalizeRelativePath(cwd, fallbackAbs),
    platform: 'other'
  });
  return targets;
}

function attachTargetsToPlannedFiles(
  cwd: string,
  plannedFiles: PlannedFile[],
  platforms: Platform[]
): void {
  // Precompute overrides: base universal path → set of platforms that have platform-suffixed variants
  const overriddenByBase = new Map<string, Set<Platform>>();
  for (const pf of plannedFiles) {
    const parsed = parseUniversalPath(pf.registryPath);
    if (parsed?.platformSuffix) {
      const baseKey = `${parsed.universalSubdir}/${parsed.relPath}`;
      if (!overriddenByBase.has(baseKey)) {
        overriddenByBase.set(baseKey, new Set());
      }
      overriddenByBase.get(baseKey)!.add(parsed.platformSuffix as Platform);
    }
  }

  for (const planned of plannedFiles) {
    const targets = mapRegistryPathToTargets(cwd, planned.registryPath, platforms);

    const parsed = parseUniversalPath(planned.registryPath);
    if (parsed && !parsed.platformSuffix) {
      // Universal file: exclude platforms that have platform-specific variants
      const baseKey = `${parsed.universalSubdir}/${parsed.relPath}`;
      const excludedPlatforms = overriddenByBase.get(baseKey);
      if (excludedPlatforms && excludedPlatforms.size > 0) {
        planned.targets = targets.filter(t => 
          !(t.platform && t.platform !== 'ai' && t.platform !== 'other' && excludedPlatforms.has(t.platform as Platform))
        );
      } else {
        planned.targets = targets;
      }
    } else {
      // Platform-suffixed file: use all targets as-is
      planned.targets = targets;
    }
  }
}

// ============================================================================
// Directory Collection Functions
// ============================================================================

function collectTargetDirectories(plannedFiles: PlannedFile[]): Set<string> {
  const dirs = new Set<string>();
  for (const planned of plannedFiles) {
    for (const target of planned.targets) {
      const dirName = dirname(target.relPath);
      if (!dirName || dirName === '.') continue;
      dirs.add(ensureTrailingSlash(normalizePathForProcessing(dirName)));
    }
  }
  return dirs;
}

function collectTargetDirectoriesByPlatform(
  plannedFiles: PlannedFile[]
): Map<Platform | 'ai' | 'other', Set<string>> {
  const dirsByPlatform = new Map<Platform | 'ai' | 'other', Set<string>>();
  
  for (const planned of plannedFiles) {
    for (const target of planned.targets) {
      const platform = target.platform ?? 'other';
      if (!dirsByPlatform.has(platform)) {
        dirsByPlatform.set(platform, new Set());
      }
      const dirName = dirname(target.relPath);
      if (!dirName || dirName === '.') continue;
      dirsByPlatform.get(platform)!.add(ensureTrailingSlash(normalizePathForProcessing(dirName)));
    }
  }
  
  return dirsByPlatform;
}

async function directoryHasEntries(absDir: string): Promise<boolean> {
  if (!(await exists(absDir))) return false;
  const files = await listFiles(absDir).catch(() => [] as string[]);
  if (files.length > 0) return true;
  const subdirs = await listDirectories(absDir).catch(() => [] as string[]);
  return subdirs.length > 0;
}

// ============================================================================
// Platform Decision Functions
// ============================================================================

async function checkPlatformDirectoryOccupancy(
  cwd: string,
  platformDirs: Set<string>
): Promise<boolean> {
  for (const dirRel of platformDirs) {
    const absDir = join(cwd, dirRel);
    if (await directoryHasEntries(absDir)) {
      return true;
    }
  }
  return false;
}

function hadPreviousDirForPlatform(
  previousIndex: PackageIndexRecord | null,
  groupKey: string,
  platform: Platform | 'ai' | 'other'
): boolean {
  if (!previousIndex || platform === 'other') {
    return false;
  }

  const prevValues = previousIndex.files[groupKey] ?? [];
  if (prevValues.length === 0) {
    return false;
  }

  const rootDir = platform === 'ai'
    ? normalizePathForProcessing(DIR_PATTERNS.AI)
    : normalizePathForProcessing(getPlatformDefinition(platform as Platform).rootDir);

  for (const value of prevValues) {
    const normalizedValue = normalizePathForProcessing(value);
    if (
      normalizedValue === rootDir ||
      normalizedValue.startsWith(`${rootDir}/`)
    ) {
      return true;
    }
  }

  return false;
}

async function determinePlatformDecisions(
  cwd: string,
  targetDirsByPlatform: Map<Platform | 'ai' | 'other', Set<string>>,
  wasDirKey: boolean,
  previousIndex: PackageIndexRecord | null,
  groupKey: string
): Promise<Map<Platform | 'ai' | 'other', 'dir' | 'file'>> {
  const platformDecisions = new Map<Platform | 'ai' | 'other', 'dir' | 'file'>();

  for (const [platform, platformDirs] of targetDirsByPlatform.entries()) {
    if (wasDirKey && hadPreviousDirForPlatform(previousIndex, groupKey, platform)) {
      platformDecisions.set(platform, 'dir');
      continue;
    }

    const directoryOccupied = await checkPlatformDirectoryOccupancy(cwd, platformDirs);
    platformDecisions.set(platform, directoryOccupied ? 'file' : 'dir');
  }

  return platformDecisions;
}

function computeOverallDecision(
  platformDecisions: Map<Platform | 'ai' | 'other', 'dir' | 'file'>
): 'dir' | 'file' {
  // Use 'dir' if at least one platform can use it
  // (buildIndexMappingFromPlans will handle per-platform logic)
  const hasAnyDirDecision = Array.from(platformDecisions.values()).some(d => d === 'dir');
  return hasAnyDirDecision ? 'dir' : 'file';
}

async function decideGroupPlans(
  cwd: string,
  groups: Map<string, PlannedFile[]>,
  previousIndex: PackageIndexRecord | null,
  context: ExpandedIndexesContext
): Promise<GroupPlan[]> {
  const plans: GroupPlan[] = [];
  const previousDirKeys = new Set(
    previousIndex
      ? Object.keys(previousIndex.files).filter(key => isDirKey(key))
      : []
  );

  for (const [groupKey, plannedFiles] of groups.entries()) {
    const targetDirs = collectTargetDirectories(plannedFiles);
    const targetDirsByPlatform = collectTargetDirectoriesByPlatform(plannedFiles);
    let decision: 'dir' | 'file' = 'file';
    const platformDecisions = new Map<Platform | 'ai' | 'other', 'dir' | 'file'>();

    const otherDirOwners = context.dirKeyOwners.get(groupKey) ?? [];
    const hasTargets = plannedFiles.some(file => file.targets.length > 0);

    if (groupKey !== '' && hasTargets && otherDirOwners.length === 0) {
      const wasDirKey = previousDirKeys.has(groupKey);
      const computedDecisions = await determinePlatformDecisions(
        cwd,
        targetDirsByPlatform,
        wasDirKey,
        previousIndex,
        groupKey
      );
      platformDecisions.clear();
      computedDecisions.forEach((value, key) => platformDecisions.set(key, value));
      decision = computeOverallDecision(platformDecisions);
    }

    plans.push({
      key: groupKey,
      plannedFiles,
      decision,
      platformDecisions,
      targetDirs
    });
  }

  return plans;
}

// ============================================================================
// Shared Helper for Building Index Mappings
// ============================================================================

/**
 * Build index mapping for package files using the same logic flow as installPackageByIndex
 * This function reuses the planning, grouping, and decision logic to ensure consistency
 * between installation and sync operations.
 * 
 * @param cwd - Current working directory
 * @param packageFiles - Array of package files to build mapping for
 * @param platforms - Platforms to map files to
 * @param previousIndex - Previous index record (if any)
 * @param otherIndexes - Other package indexes for conflict detection
 * @returns Record mapping registry paths to installed paths
 */
export async function buildIndexMappingForPackageFiles(
  cwd: string,
  packageFiles: PackageFile[],
  platforms: Platform[],
  previousIndex: PackageIndexRecord | null,
  otherIndexes: PackageIndexRecord[]
): Promise<Record<string, string[]>> {
  // Convert PackageFile[] to RegistryFileEntry[] format
  const registryEntries: RegistryFileEntry[] = packageFiles
    .filter(file => {
      const normalized = normalizeRegistryPath(file.path);
      // Skip root files and skippable paths (same logic as loadRegistryFileEntries)
      if (isRootRegistryPath(normalized)) return false;
      if (isSkippableRegistryPath(normalized)) return false;
      return isAllowedRegistryPath(normalized);
    })
    .map(file => ({
      registryPath: normalizeRegistryPath(file.path),
      content: file.content,
      encoding: file.encoding as string | undefined
    }));

  if (registryEntries.length === 0) {
    return {};
  }

  // Reuse existing planning logic - this ensures consistency with installPackageByIndex
  const plannedFiles = createPlannedFiles(registryEntries);
  attachTargetsToPlannedFiles(cwd, plannedFiles, platforms);
  
  const groups = groupPlannedFiles(plannedFiles);
  const context = await buildExpandedIndexesContext(cwd, otherIndexes);
  const groupPlans = await decideGroupPlans(cwd, groups, previousIndex, context);
  
  // Build the mapping using the same logic as installPackageByIndex
  return buildIndexMappingFromPlans(groupPlans);
}

function filterRegistryEntriesForPackageFiles(packageFiles: PackageFile[]): RegistryFileEntry[] {
  return packageFiles
    .filter(file => {
      const normalized = normalizeRegistryPath(file.path);
      if (isRootRegistryPath(normalized)) return false;
      if (isSkippableRegistryPath(normalized)) return false;
      return isAllowedRegistryPath(normalized);
    })
    .map(file => ({
      registryPath: normalizeRegistryPath(file.path),
      content: file.content,
      encoding: file.encoding as string | undefined
    }));
}

export interface PlannedSyncOutcome {
  operation: IndexInstallResult;
  mapping: Record<string, string[]>;
}

export async function applyPlannedSyncForPackageFiles(
  cwd: string,
  packageName: string,
  version: string,
  packageFiles: PackageFile[],
  platforms: Platform[],
  options: InstallOptions
): Promise<PlannedSyncOutcome> {
  const registryEntries = filterRegistryEntriesForPackageFiles(packageFiles);

  const plannedFiles = createPlannedFiles(registryEntries);
  attachTargetsToPlannedFiles(cwd, plannedFiles, platforms);

  const previousIndex = await readPackageIndex(cwd, packageName);
  const otherIndexes = await loadOtherPackageIndexes(cwd, packageName);
  const context = await buildExpandedIndexesContext(cwd, otherIndexes);

  const groups = groupPlannedFiles(plannedFiles);
  const groupPlans = await decideGroupPlans(cwd, groups, previousIndex, context);
  const previousOwnedPaths = await expandIndexToFilePaths(cwd, previousIndex);

  const conflictWarnings = await resolveConflictsForPlannedFiles(
    cwd,
    plannedFiles,
    context,
    otherIndexes,
    previousOwnedPaths,
    options
  );
  for (const warning of conflictWarnings) {
    logger.warn(warning);
  }

  const plannedTargetMap = buildPlannedTargetMap(plannedFiles, packageFiles);
  const { planned, deletions } = computeDiff(plannedTargetMap, previousOwnedPaths);

  const operationResult = await applyFileOperations(cwd, planned, deletions, options);

  let mapping: Record<string, string[]> = {};
  if (!options.dryRun) {
    mapping = buildIndexMappingFromPlans(groupPlans);
    const workspaceHash = previousIndex?.workspace?.hash ?? createWorkspaceHash(cwd);
    const indexRecord: PackageIndexRecord = {
      path: getPackageIndexPath(cwd, packageName),
      packageName,
      workspace: {
        hash: workspaceHash,
        version
      },
      files: mapping
    };
    await writePackageIndex(indexRecord);
  }

  return {
    operation: operationResult,
    mapping
  };
}







