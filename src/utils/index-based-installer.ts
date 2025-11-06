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
import { getLocalFormulasDir } from './paths.js';
import { formulaManager } from '../core/formula.js';
import { logger } from './logger.js';
import {
  PLATFORM_DIRS,
  FILE_PATTERNS,
  UNIVERSAL_SUBDIRS,
  type Platform
} from '../constants/index.js';
import { getFirstPathComponent, getPathAfterFirstComponent, normalizePathForProcessing } from './path-normalization.js';
import { mapUniversalToPlatform } from './platform-mapper.js';
import { safePrompts } from './prompts.js';
import type { InstallOptions } from '../types/index.js';
import type { FormulaFile } from '../types/index.js';
import { mergePlatformYamlOverride } from './platform-yaml-merge.js';
import { parseUniversalPath } from './platform-file.js';
import { loadRegistryYamlOverrides } from './id-based-discovery.js';

import {
  FORMULA_INDEX_FILENAME,
  getFormulaIndexPath,
  readFormulaIndex,
  writeFormulaIndex,
  sortMapping,
  ensureTrailingSlash,
  isDirKey,
  type FormulaIndexRecord,
} from './formula-index-yml.js';

const ROOT_FILE_PATTERNS = [
  FILE_PATTERNS.AGENTS_MD,
  FILE_PATTERNS.CLAUDE_MD,
  FILE_PATTERNS.GEMINI_MD,
  FILE_PATTERNS.QWEN_MD,
  FILE_PATTERNS.WARP_MD
];

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
  targetDirs: Set<string>;
}

interface ConflictOwner {
  formulaName: string;
  key: string;
  type: 'file' | 'dir';
  indexPath: string;
}

interface ExpandedIndexesContext {
  dirKeyOwners: Map<string, ConflictOwner[]>;
  installedPathOwners: Map<string, ConflictOwner>;
}

type ConflictResolution = 'rename' | 'skip';

interface PlannedTargetDetail {
  absPath: string;
  relPath: string;
  content: string;
  encoding?: string;
}

function generateConflictRenamePath(relPath: string): string {
  const parsed = parsePath(relPath);
  const suffix = `.conflicted-${Date.now()}`;
  const newBase = `${parsed.name}${suffix}${parsed.ext}`;
  const directory = parsed.dir ? parsed.dir.replace(/\\/g, '/') : '';
  return directory ? `${directory}/${newBase}` : newBase;
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
        title: 'Rename existing file and continue',
        value: 'rename'
      },
      {
        title: 'Keep existing file (skip installing new one)',
        value: 'skip'
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
  indexByFormula: Map<string, FormulaIndexRecord>
): Promise<void> {
  const normalizedOld = normalizePathForProcessing(oldRelPath);
  const normalizedNew = normalizePathForProcessing(newRelPath);
  const record = indexByFormula.get(owner.formulaName);
  if (!record) return;

  if (owner.type === 'file') {
    const values = record.files[owner.key];
    if (!values) return;
    const idx = values.findIndex(value => normalizePathForProcessing(value) === normalizedOld);
    if (idx === -1) return;
    values[idx] = normalizedNew;
    await writeFormulaIndex(record);
  } else {
    // Directory key still valid; nothing to change.
  }
}

async function resolveConflictsForPlannedFiles(
  cwd: string,
  plannedFiles: PlannedFile[],
  context: ExpandedIndexesContext,
  otherIndexes: FormulaIndexRecord[],
  previousOwnedPaths: Set<string>,
  options: InstallOptions
): Promise<string[]> {
  const warnings: string[] = [];
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const isDryRun = Boolean(options.dryRun);
  const indexByFormula = new Map<string, FormulaIndexRecord>();
  for (const record of otherIndexes) {
    indexByFormula.set(record.formulaName, record);
  }

  for (const planned of plannedFiles) {
    const filteredTargets: PlannedTarget[] = [];

    for (const target of planned.targets) {
      const normalizedRel = normalizePathForProcessing(target.relPath);
      const absTarget = join(cwd, normalizedRel);
      const owner = context.installedPathOwners.get(normalizedRel);

      if (owner) {
        let proceed = false;
        if (options.force) {
          proceed = true;
        } else if (!interactive) {
          warnings.push(`Skipping ${normalizedRel} (owned by ${owner.formulaName}) due to non-interactive conflict.`);
        } else {
          const choice = await promptConflictResolution(
            `File ${normalizedRel} is managed by formula ${owner.formulaName}. How would you like to proceed?`
          );
          proceed = choice === 'rename';
          if (!proceed) {
            warnings.push(`Skipped ${normalizedRel} (kept existing from ${owner.formulaName}).`);
          }
        }

        if (!proceed) {
          continue;
        }

        if (isDryRun) {
          warnings.push(`Would rename existing ${normalizedRel} from ${owner.formulaName} during install.`);
          filteredTargets.push(target);
          continue;
        }

        const newRelPath = generateConflictRenamePath(normalizedRel);
        const absNewPath = join(cwd, newRelPath);
        await ensureDir(dirname(absNewPath));
        try {
          await fs.rename(absTarget, absNewPath);
          await updateOwnerIndexAfterRename(owner, normalizedRel, newRelPath, indexByFormula);
          context.installedPathOwners.delete(normalizedRel);
          context.installedPathOwners.set(normalizePathForProcessing(newRelPath), owner);
          warnings.push(`Renamed existing ${normalizedRel} to ${newRelPath} to avoid conflict.`);
          filteredTargets.push(target);
        } catch (error) {
          warnings.push(`Failed to rename ${normalizedRel}: ${error}`);
        }
        continue;
      }

      if (!previousOwnedPaths.has(normalizedRel) && (await exists(absTarget))) {
        let proceed = false;
        if (options.force) {
          proceed = true;
        } else if (!interactive) {
          warnings.push(`Skipping ${normalizedRel} because it already exists and cannot prompt in non-interactive mode.`);
        } else {
          const choice = await promptConflictResolution(
            `File ${normalizedRel} already exists in your project. How would you like to proceed?`
          );
          proceed = choice === 'rename';
          if (!proceed) {
            warnings.push(`Skipped ${normalizedRel} (kept existing local file).`);
          }
        }

        if (!proceed) {
          continue;
        }

        if (isDryRun) {
          warnings.push(`Would rename existing local file ${normalizedRel} during install.`);
          filteredTargets.push(target);
          continue;
        }

        const newRelPath = generateConflictRenamePath(normalizedRel);
        const absNewPath = join(cwd, newRelPath);
        await ensureDir(dirname(absNewPath));
        try {
          await fs.rename(absTarget, absNewPath);
          warnings.push(`Renamed existing local file ${normalizedRel} to ${newRelPath}.`);
          filteredTargets.push(target);
        } catch (error) {
          warnings.push(`Failed to rename existing local file ${normalizedRel}: ${error}`);
        }
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

function normalizeRelativePath(cwd: string, absPath: string): string {
  const rel = relative(cwd, absPath);
  const normalized = normalizePathForProcessing(rel);
  return normalized.replace(/\\/g, '/');
}

async function collectFormulaDirectories(
  cwd: string
): Promise<Array<{ formulaName: string; dir: string }>> {
  const formulasRoot = getLocalFormulasDir(cwd);
  if (!(await exists(formulasRoot))) {
    return [];
  }

  const results: Array<{ formulaName: string; dir: string }> = [];

  async function recurse(currentDir: string, relativeBase: string): Promise<void> {
    const formulaYmlPath = join(currentDir, FILE_PATTERNS.FORMULA_YML);
    if (await exists(formulaYmlPath)) {
      const formulaName = relativeBase.replace(new RegExp(`\\${sep}`, 'g'), '/');
      results.push({ formulaName, dir: currentDir });
      return;
    }

    const subdirs = await listDirectories(currentDir).catch(() => [] as string[]);
    for (const subdir of subdirs) {
      const nextDir = join(currentDir, subdir);
      const nextRelative = relativeBase ? `${relativeBase}${sep}${subdir}` : subdir;
      await recurse(nextDir, nextRelative);
    }
  }

  const topLevelDirs = await listDirectories(formulasRoot).catch(() => [] as string[]);
  for (const dir of topLevelDirs) {
    const absolute = join(formulasRoot, dir);
    await recurse(absolute, dir);
  }

  return results;
}

async function loadOtherFormulaIndexes(
  cwd: string,
  excludeFormula: string
): Promise<FormulaIndexRecord[]> {
  const directories = await collectFormulaDirectories(cwd);
  const results: FormulaIndexRecord[] = [];

  for (const entry of directories) {
    if (entry.formulaName === excludeFormula) continue;
    const indexPath = join(entry.dir, FORMULA_INDEX_FILENAME);
    if (!(await exists(indexPath))) continue;

    const record = await readFormulaIndex(cwd, entry.formulaName);
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
  indexes: FormulaIndexRecord[]
): Promise<ExpandedIndexesContext> {
  const dirKeyOwners = new Map<string, ConflictOwner[]>();
  const installedPathOwners = new Map<string, ConflictOwner>();

  for (const record of indexes) {
    for (const [rawKey, values] of Object.entries(record.files)) {
      const key = normalizePathForProcessing(rawKey);
      const owner: ConflictOwner = {
        formulaName: record.formulaName,
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

function normalizeRegistryPath(registryPath: string): string {
  return normalizePathForProcessing(registryPath);
}

function isSkippableRegistryPath(registryPath: string): boolean {
  const normalized = normalizeRegistryPath(registryPath);
  if (normalized === FILE_PATTERNS.FORMULA_YML) return true;
  return false;
}

function isRootFile(registryPath: string): boolean {
  const normalized = normalizeRegistryPath(registryPath);
  return ROOT_FILE_PATTERNS.some(pattern =>
    normalized.endsWith(`/${pattern}`) || normalized === pattern
  );
}

async function loadRegistryFileEntries(
  formulaName: string,
  version: string
): Promise<RegistryFileEntry[]> {
  const formula = await formulaManager.loadFormula(formulaName, version);
  const entries: RegistryFileEntry[] = [];

  for (const file of formula.files) {
    const normalized = normalizeRegistryPath(file.path);

    // Skip root files - these are handled by installRootFilesFromMap
    if (isRootFile(normalized)) {
      continue;
    }

    if (isSkippableRegistryPath(normalized)) {
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

  if (first === PLATFORM_DIRS.AI) {
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

function buildPlannedTargetMap(plannedFiles: PlannedFile[], yamlOverrides: FormulaFile[]): Map<string, PlannedTargetDetail> {
  const map = new Map<string, PlannedTargetDetail>();
  for (const planned of plannedFiles) {
    for (const target of planned.targets) {
      const normalizedRel = normalizePathForProcessing(target.relPath);

      // Compute per-target content (apply platform YAML overrides for universal files)
      let content = planned.content;
      const parsed = parseUniversalPath(planned.registryPath);
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

function refreshGroupTargetDirs(plan: GroupPlan): void {
  plan.targetDirs = collectTargetDirectories(plan.plannedFiles);
}

function buildIndexMappingFromPlans(plans: GroupPlan[]): Record<string, string[]> {
  const mapping: Record<string, string[]> = {};

  for (const plan of plans) {
    refreshGroupTargetDirs(plan);

    if (plan.decision === 'dir' && plan.key !== '' && plan.targetDirs.size > 0) {
      const key = ensureTrailingSlash(plan.key);
      const values = Array.from(plan.targetDirs).map(dir => ensureTrailingSlash(dir)).sort();
      mapping[key] = values;
      continue;
    }

    for (const file of plan.plannedFiles) {
      if (file.targets.length === 0) continue;
      const values = Array.from(
        new Set(
          file.targets.map(target => normalizePathForProcessing(target.relPath))
        )
      ).sort();
      mapping[normalizeRegistryPath(file.registryPath)] = values;
    }
  }

  return sortMapping(mapping);
}

export async function installFormulaByIndex(
  cwd: string,
  formulaName: string,
  version: string,
  platforms: Platform[],
  options: InstallOptions
): Promise<IndexInstallResult> {
  const registryEntries = await loadRegistryFileEntries(formulaName, version);

  const plannedFiles = createPlannedFiles(registryEntries);
  attachTargetsToPlannedFiles(cwd, plannedFiles, platforms);

  const groups = groupPlannedFiles(plannedFiles);
  const previousIndex = await readFormulaIndex(cwd, formulaName);
  const otherIndexes = await loadOtherFormulaIndexes(cwd, formulaName);
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
  const yamlOverrides = await loadRegistryYamlOverrides(formulaName, version);

  const plannedTargetMap = buildPlannedTargetMap(plannedFiles, yamlOverrides);
  const { planned, deletions } = computeDiff(plannedTargetMap, previousOwnedPaths);

  const operationResult = await applyFileOperations(cwd, planned, deletions, options);

  if (!options.dryRun) {
    const mapping = buildIndexMappingFromPlans(groupPlans);
    const indexRecord: FormulaIndexRecord = {
      path: getFormulaIndexPath(cwd, formulaName),
      formulaName,
      version,
      files: mapping
    };
    await writeFormulaIndex(indexRecord);
  }

  return operationResult;
}





async function expandIndexToFilePaths(
  cwd: string,
  index: FormulaIndexRecord | null
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
  const rest = getPathAfterFirstComponent(normalized);
  const targets: PlannedTarget[] = [];

  const universalValues = Object.values(UNIVERSAL_SUBDIRS) as string[];

  if (first === PLATFORM_DIRS.AI) {
    const targetAbs = join(cwd, normalized);
    targets.push({
      absPath: targetAbs,
      relPath: normalizeRelativePath(cwd, targetAbs),
      platform: 'ai'
    });
    return targets;
  }

  if (universalValues.includes(first)) {
    for (const platform of platforms) {
      try {
        const mapped = mapUniversalToPlatform(platform, first as UniversalSubdir, rest);
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
  for (const planned of plannedFiles) {
    planned.targets = mapRegistryPathToTargets(cwd, planned.registryPath, platforms);
  }
}

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


async function directoryHasEntries(absDir: string): Promise<boolean> {
  if (!(await exists(absDir))) return false;
  const files = await listFiles(absDir).catch(() => [] as string[]);
  if (files.length > 0) return true;
  const subdirs = await listDirectories(absDir).catch(() => [] as string[]);
  return subdirs.length > 0;
}

async function decideGroupPlans(
  cwd: string,
  groups: Map<string, PlannedFile[]>,
  previousIndex: FormulaIndexRecord | null,
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
    let decision: 'dir' | 'file' = 'file';

    const otherDirOwners = context.dirKeyOwners.get(groupKey) ?? [];
    const hasTargets = plannedFiles.some(file => file.targets.length > 0);

    if (
      groupKey !== '' &&
      hasTargets &&
      otherDirOwners.length === 0
    ) {
      if (previousDirKeys.has(groupKey)) {
        decision = 'dir';
      } else {
        let directoryOccupied = false;
        for (const dirRel of targetDirs) {
          const absDir = join(cwd, dirRel);
          if (await directoryHasEntries(absDir)) {
            directoryOccupied = true;
            break;
          }
        }
        decision = directoryOccupied ? 'file' : 'dir';
      }
    }

    plans.push({
      key: groupKey,
      plannedFiles,
      decision,
      targetDirs
    });
  }

  return plans;
}








