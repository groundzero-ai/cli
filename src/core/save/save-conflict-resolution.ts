import { dirname, join } from 'path';
import type { FormulaFile } from '../../types/index.js';
import type { FormulaYmlInfo } from './formula-yml-generator.js';
import { FILE_PATTERNS, PLATFORM_DIRS, PLATFORMS, type Platform } from '../../constants/index.js';
import { FORMULA_INDEX_FILENAME, readFormulaIndex, isDirKey } from '../../utils/formula-index-yml.js';
import { getLocalFormulaDir } from '../../utils/paths.js';
import { ensureDir, exists, isDirectory, readTextFile, writeTextFile } from '../../utils/fs.js';
import { findFilesByExtension, getFileMtime } from '../../utils/file-processing.js';
import { calculateFileHash } from '../../utils/hash-utils.js';
import {
  isAllowedRegistryPath,
  normalizeRegistryPath,
  isRootRegistryPath,
  isSkippableRegistryPath
} from '../../utils/registry-entry-filter.js';
import { discoverPlatformFilesUnified } from '../discovery/platform-files-discovery.js';
import { getRelativePathFromBase } from '../../utils/path-normalization.js';
import { UTF8_ENCODING } from './constants.js';
import { safePrompts, promptPlatformSpecificSelection, getContentPreview } from '../../utils/prompts.js';
import { createPlatformSpecificRegistryPath } from '../../utils/platform-specific-paths.js';
import { logger } from '../../utils/logger.js';
import { SaveCandidate } from './save-candidate-types.js';
import type { SaveConflictResolution } from './save-conflict-types.js';
import {
  discoverWorkspaceRootSaveCandidates,
  loadLocalRootSaveCandidates
} from './root-save-candidates.js';
import { splitFrontmatter, stripFrontmatter } from '../../utils/markdown-frontmatter.js';
import {
  buildFrontmatterMergePlans,
  applyFrontmatterMergePlans,
  type SaveCandidateGroup
} from './save-yml-resolution.js';
import { inferPlatformFromWorkspaceFile } from '../platforms.js';

export interface SaveConflictResolutionOptions {
  force?: boolean;
}

export async function resolveFormulaFilesWithConflicts(
  formulaInfo: FormulaYmlInfo,
  options: SaveConflictResolutionOptions = {}
): Promise<FormulaFile[]> {
  const cwd = process.cwd();
  const formulaDir = getLocalFormulaDir(cwd, formulaInfo.config.name);

  if (!(await exists(formulaDir)) || !(await isDirectory(formulaDir))) {
    return [];
  }

  const [
    localPlatformCandidates,
    workspacePlatformCandidates,
    localRootCandidates,
    workspaceRootCandidates
  ] = await Promise.all([
    loadLocalCandidates(formulaDir),
    discoverWorkspaceCandidates(cwd, formulaInfo.config.name),
    loadLocalRootSaveCandidates(formulaDir, formulaInfo.config.name),
    discoverWorkspaceRootSaveCandidates(cwd, formulaInfo.config.name)
  ]);

  const localCandidates = [...localPlatformCandidates, ...localRootCandidates];

  const indexRecord = await readFormulaIndex(cwd, formulaInfo.config.name);

  if (!indexRecord || Object.keys(indexRecord.files ?? {}).length === 0) {
    // No index yet (first save) – run root-only conflict resolution so prompts are shown for CLAUDE.md, WARP.md, etc.
    const rootGroups = buildCandidateGroups(localRootCandidates, workspaceRootCandidates);

    // Prune platform-specific root candidates that already exist locally (e.g., CLAUDE.md present)
    await pruneWorkspaceCandidatesWithLocalPlatformVariants(formulaDir, rootGroups);

    for (const group of rootGroups) {
      const hasLocal = !!group.local;
      const hasWorkspace = group.workspace.length > 0;

      // A "differing" workspace set means either:
      // - there is no local file yet (creation case), or
      // - at least one workspace candidate differs from local
      const hasDifferingWorkspace =
        hasWorkspace &&
        (!hasLocal || group.workspace.some(w => w.contentHash !== group.local?.contentHash));

      // If there are no workspace candidates, or all workspace candidates are identical
      // to the local one, there's nothing to do.
      if (!hasWorkspace || !hasDifferingWorkspace) {
        continue;
      }

      const resolution = await resolveRootGroup(group, options.force ?? false);
      if (!resolution) continue;

      const { selection, platformSpecific } = resolution;

      // Always write universal AGENTS.md from the selected root section
      await writeRootSelection(formulaDir, formulaInfo.config.name, group.local, selection);

      // Persist platform-specific root selections (e.g., CLAUDE.md, WARP.md)
      for (const candidate of platformSpecific) {
        const platform = candidate.platform;
        if (!platform || platform === 'ai') continue;

        const platformRegistryPath = createPlatformSpecificRegistryPath(group.registryPath, platform);
        if (!platformRegistryPath) continue;

        const targetPath = join(formulaDir, platformRegistryPath);
        try {
          await ensureDir(dirname(targetPath));

          const contentToWrite = candidate.isRootFile
            ? (candidate.sectionBody ?? candidate.content).trim()
            : candidate.content;

          if (await exists(targetPath)) {
            const existingContent = await readTextFile(targetPath, UTF8_ENCODING);
            if (existingContent === contentToWrite) {
              continue;
            }
          }

          await writeTextFile(targetPath, contentToWrite, UTF8_ENCODING);
          logger.debug(`Wrote platform-specific file: ${platformRegistryPath}`);
        } catch (error) {
          logger.warn(`Failed to write platform-specific file ${platformRegistryPath}: ${error}`);
        }
      }
    }

    // After resolving root conflicts, return filtered files from local dir
    return await readFilteredLocalFormulaFiles(formulaDir);
  }

  const fileKeys = new Set<string>();
  const dirKeys: string[] = [];

  for (const rawKey of Object.keys(indexRecord.files)) {
    if (isDirKey(rawKey)) {
      const trimmed = rawKey.endsWith('/') ? rawKey.slice(0, -1) : rawKey;
      if (!trimmed) {
        continue;
      }
      const normalized = normalizeRegistryPath(trimmed);
      dirKeys.push(`${normalized}/`);
    } else {
      fileKeys.add(normalizeRegistryPath(rawKey));
    }
  }

  const isAllowedRegistryPathForFormula = (registryPath: string): boolean => {
    const normalizedPath = normalizeRegistryPath(registryPath);
    if (fileKeys.has(normalizedPath)) {
      return true;
    }
    return dirKeys.some(dirKey => normalizedPath.startsWith(dirKey));
  };

  const filteredWorkspacePlatformCandidates = workspacePlatformCandidates.filter(candidate =>
    isAllowedRegistryPathForFormula(candidate.registryPath)
  );

  const filteredWorkspaceRootCandidates = workspaceRootCandidates.filter(candidate =>
    candidate.isRootFile || isAllowedRegistryPathForFormula(candidate.registryPath)
  );

  const workspaceCandidates = [...filteredWorkspacePlatformCandidates, ...filteredWorkspaceRootCandidates];

  const groups = buildCandidateGroups(localCandidates, workspaceCandidates);
  const frontmatterPlans = buildFrontmatterMergePlans(groups);

  // Prune platform-specific workspace candidates that already have local platform-specific files
  await pruneWorkspaceCandidatesWithLocalPlatformVariants(formulaDir, groups);

  // Resolve conflicts and write chosen content back to local files
  for (const group of groups) {
    const hasLocal = !!group.local;
    const hasWorkspace = group.workspace.length > 0;

    const hasDifferingWorkspace =
      hasWorkspace &&
      (!hasLocal || group.workspace.some(w => w.contentHash !== group.local?.contentHash));

    // If there are no workspace candidates, or all workspace candidates are identical
    // to the local one, skip.
    if (!hasWorkspace || !hasDifferingWorkspace) {
      continue;
    }

    const isRootConflict =
      group.registryPath === FILE_PATTERNS.AGENTS_MD &&
      ((group.local && group.local.isRootFile) || group.workspace.some(w => w.isRootFile));

    const resolution = isRootConflict
      ? await resolveRootGroup(group, options.force ?? false)
      : await resolveGroup(group, options.force ?? false);
    if (!resolution) continue;

    const { selection, platformSpecific } = resolution;

    if (group.registryPath === FILE_PATTERNS.AGENTS_MD && selection.isRootFile) {
      await writeRootSelection(formulaDir, formulaInfo.config.name, group.local, selection);
      // Continue to platform-specific persistence below (don't skip it)
    } else {
      if (group.local && selection.contentHash !== group.local.contentHash) {
        // Overwrite local file content with selected content
        const targetPath = join(formulaDir, group.registryPath);
        try {
          await writeTextFile(targetPath, selection.content, UTF8_ENCODING);
          logger.debug(`Updated local file with selected content: ${group.registryPath}`);
        } catch (error) {
          logger.warn(`Failed to write selected content to ${group.registryPath}: ${error}`);
        }
      } else if (!group.local) {
        // No local file existed; write the selected content to create it
        const targetPath = join(formulaDir, group.registryPath);
        try {
          await ensureDir(dirname(targetPath));
          await writeTextFile(targetPath, selection.content, UTF8_ENCODING);
          logger.debug(`Created local file with selected content: ${group.registryPath}`);
        } catch (error) {
          logger.warn(`Failed to create selected content for ${group.registryPath}: ${error}`);
        }
      }
    }

    // Persist platform-specific selections chosen during conflict resolution
    // For root files, this writes platform-specific root files (e.g., CLAUDE.md, WARP.md)
    for (const candidate of platformSpecific) {
      const platform = candidate.platform;
      if (!platform || platform === 'ai') {
        continue;
      }

      const platformRegistryPath = createPlatformSpecificRegistryPath(group.registryPath, platform);
      if (!platformRegistryPath) {
        continue;
      }

      const targetPath = join(formulaDir, platformRegistryPath);

      try {
        await ensureDir(dirname(targetPath));

        // For root files, use sectionBody (extracted formula content) instead of full content
        const contentToWrite = candidate.isRootFile
          ? (candidate.sectionBody ?? candidate.content).trim()
          : candidate.content;

        if (await exists(targetPath)) {
          const existingContent = await readTextFile(targetPath, UTF8_ENCODING);
          if (existingContent === contentToWrite) {
            continue;
          }
        }

        await writeTextFile(targetPath, contentToWrite, UTF8_ENCODING);
        logger.debug(`Wrote platform-specific file: ${platformRegistryPath}`);
      } catch (error) {
        logger.warn(`Failed to write platform-specific file ${platformRegistryPath}: ${error}`);
      }
    }
  }

  // After resolving conflicts by updating local files, simply read filtered files from local dir
  await applyFrontmatterMergePlans(formulaDir, frontmatterPlans);
  return await readFilteredLocalFormulaFiles(formulaDir);
}

async function loadLocalCandidates(formulaDir: string): Promise<SaveCandidate[]> {
  const entries = await findFilesByExtension(formulaDir, [], formulaDir);

  const candidates: SaveCandidate[] = [];

  for (const entry of entries) {
    const normalizedPath = normalizeRegistryPath(entry.relativePath);

    if (normalizedPath === FORMULA_INDEX_FILENAME) {
      continue;
    }

    if (normalizedPath === FILE_PATTERNS.AGENTS_MD) {
      continue;
    }

    if (!isAllowedRegistryPath(normalizedPath)) {
      continue;
    }

    const fullPath = entry.fullPath;
    const content = await readTextFile(fullPath);
    const isMarkdown = normalizedPath.endsWith(FILE_PATTERNS.MD_FILES);
    const split = isMarkdown ? splitFrontmatter(content) : undefined;
    const markdownBody = split ? split.body : content;
    const frontmatter = split?.frontmatter ?? undefined;
    const rawFrontmatter = split?.rawFrontmatter;
    const contentHash = await calculateContentHash(normalizedPath, content);
    const mtime = await getFileMtime(fullPath);

    candidates.push({
      source: 'local',
      registryPath: normalizedPath,
      fullPath,
      content,
      contentHash,
      mtime,
      displayPath: normalizedPath,
      isMarkdown,
      frontmatter,
      rawFrontmatter,
      markdownBody
    });
  }

  return candidates;
}

async function discoverWorkspaceCandidates(cwd: string, formulaName: string): Promise<SaveCandidate[]> {
  const discovered = await discoverPlatformFilesUnified(cwd, formulaName);

  const candidates: SaveCandidate[] = [];

  for (const file of discovered) {
    const normalizedPath = normalizeRegistryPath(file.registryPath);

    if (!isAllowedRegistryPath(normalizedPath)) {
      continue;
    }

    const content = await readTextFile(file.fullPath);
    const isMarkdown = normalizedPath.endsWith(FILE_PATTERNS.MD_FILES);
    const split = isMarkdown ? splitFrontmatter(content) : undefined;
    const markdownBody = split ? split.body : content;
    const frontmatter = split?.frontmatter ?? undefined;
    const rawFrontmatter = split?.rawFrontmatter;
    const contentHash = await calculateContentHash(normalizedPath, content);
    const displayPath = getRelativePathFromBase(file.fullPath, cwd) || normalizedPath;
    const platform = inferPlatformFromWorkspaceFile(file.fullPath, file.sourceDir, normalizedPath);

    candidates.push({
      source: 'workspace',
      registryPath: normalizedPath,
      fullPath: file.fullPath,
      content,
      contentHash,
      mtime: file.mtime,
      displayPath,
      platform,
      isMarkdown,
      frontmatter,
      rawFrontmatter,
      markdownBody
    });
  }

  return candidates;
}



async function calculateContentHash(registryPath: string, content: string): Promise<string> {
  const isMarkdown = registryPath.endsWith(FILE_PATTERNS.MD_FILES);
  const normalizedContent = isMarkdown ? stripFrontmatter(content) : content;
  return await calculateFileHash(normalizedContent);
}

function buildCandidateGroups(
  localCandidates: SaveCandidate[],
  workspaceCandidates: SaveCandidate[]
): SaveCandidateGroup[] {
  const map = new Map<string, SaveCandidateGroup>();

  for (const candidate of localCandidates) {
    const group = ensureGroup(map, candidate.registryPath);
    group.local = candidate;
  }

  for (const candidate of workspaceCandidates) {
    const group = ensureGroup(map, candidate.registryPath);
    group.workspace.push(candidate);
  }

  return Array.from(map.values());
}

function ensureGroup(map: Map<string, SaveCandidateGroup>, registryPath: string): SaveCandidateGroup {
  let group = map.get(registryPath);
  if (!group) {
    group = {
      registryPath,
      workspace: []
    };
    map.set(registryPath, group);
  }
  return group;
}

/**
 * Prune platform-specific workspace candidates that already have local platform-specific files.
 * This prevents false conflicts when platform-specific workspace files are mapped to universal
 * registry paths but corresponding platform-specific files already exist in the formula.
 */
async function pruneWorkspaceCandidatesWithLocalPlatformVariants(
  formulaDir: string,
  groups: SaveCandidateGroup[]
): Promise<void> {
  for (const group of groups) {
    if (!group.local) {
      continue;
    }

    const filtered: SaveCandidate[] = [];
    for (const candidate of group.workspace) {
      const platform = candidate.platform;
      if (!platform || platform === 'ai') {
        // Keep non-platform-specific candidates
        filtered.push(candidate);
        continue;
      }

      const platformRegistryPath = createPlatformSpecificRegistryPath(group.registryPath, platform);
      if (!platformRegistryPath) {
        // Cannot create platform-specific path; keep candidate
        filtered.push(candidate);
        continue;
      }

      const platformFullPath = join(formulaDir, platformRegistryPath);
      if (await exists(platformFullPath)) {
        // Local platform-specific file already exists; skip this workspace candidate
        // to avoid false conflict detection
        logger.debug(
          `Skipping workspace candidate ${candidate.displayPath} for ${group.registryPath} ` +
            `because local platform-specific file ${platformRegistryPath} already exists`
        );
        continue;
      }

      // No local platform-specific file exists; keep this candidate for conflict resolution
      filtered.push(candidate);
    }

    group.workspace = filtered;
  }
}

async function resolveRootGroup(
  group: SaveCandidateGroup,
  force: boolean
): Promise<SaveConflictResolution | undefined> {
  const orderedCandidates: SaveCandidate[] = [];

  if (group.local) {
    orderedCandidates.push(group.local);
  }

  if (group.workspace.length > 0) {
    const sortedWorkspace = [...group.workspace].sort((a, b) => {
      if (b.mtime !== a.mtime) {
        return b.mtime - a.mtime;
      }
      return a.displayPath.localeCompare(b.displayPath);
    });
    orderedCandidates.push(...sortedWorkspace);
  }

  if (orderedCandidates.length === 0) {
    return undefined;
  }

  const uniqueCandidates = dedupeByHash(orderedCandidates);

  if (uniqueCandidates.length === 1) {
    return {
      selection: uniqueCandidates[0],
      platformSpecific: []
    };
  }

  if (group.local) {
    const localCandidate = group.local;
    const differsFromAnyWorkspace = group.workspace.some(w => w.contentHash !== localCandidate.contentHash);

    if (differsFromAnyWorkspace) {
      const latestWorkspaceMtime =
        group.workspace.length > 0 ? Math.max(...group.workspace.map(w => w.mtime)) : 0;

      if (localCandidate.mtime >= latestWorkspaceMtime) {
        return {
          selection: localCandidate,
          platformSpecific: []
        };
      }

      if (force) {
        logger.info(`Force-selected local version for ${group.registryPath}`);
        return {
          selection: localCandidate,
          platformSpecific: []
        };
      }

      return await promptForCandidate(group.registryPath, uniqueCandidates);
    }
  }

  if (force) {
    const selected = pickLatestByMtime(uniqueCandidates);
    logger.info(`Force-selected ${selected.displayPath} for ${group.registryPath}`);
    return {
      selection: selected,
      platformSpecific: []
    };
  }

  return await promptForCandidate(group.registryPath, uniqueCandidates);
}

async function resolveGroup(
  group: SaveCandidateGroup,
  force: boolean
): Promise<SaveConflictResolution | undefined> {
  const orderedCandidates: SaveCandidate[] = [];

  if (group.local) {
    orderedCandidates.push(group.local);
  }

  if (group.workspace.length > 0) {
    const sortedWorkspace = [...group.workspace].sort((a, b) => {
      if (b.mtime !== a.mtime) {
        return b.mtime - a.mtime;
      }
      return a.displayPath.localeCompare(b.displayPath);
    });
    orderedCandidates.push(...sortedWorkspace);
  }

  if (orderedCandidates.length === 0) {
    return undefined;
  }

  const uniqueCandidates = dedupeByHash(orderedCandidates);

  if (uniqueCandidates.length === 1) {
    return {
      selection: uniqueCandidates[0],
      platformSpecific: []
    };
  }

  // Mirror YAML override behavior: local newer -> no prompt (local wins); workspace newer -> prompt
  if (group.local) {
    const localCandidate = group.local;
    const differsFromAnyWorkspace = group.workspace.some(w => w.contentHash !== localCandidate.contentHash);
    
    if (differsFromAnyWorkspace) {
      const latestWorkspaceMtime = group.workspace.length > 0 
        ? Math.max(...group.workspace.map(w => w.mtime))
        : 0;
      
      // If local is newer or equal, use it without prompting (matches YAML override behavior)
      if (localCandidate.mtime >= latestWorkspaceMtime) {
        return {
          selection: localCandidate,
          platformSpecific: []
        };
      }
      
      // Workspace is newer: prompt unless user explicitly requested --force
      if (!force) {
        return await promptForCandidate(group.registryPath, uniqueCandidates);
      }

      // Explicit --force: always choose local version
      logger.info(`Force-selected local version for ${group.registryPath}`);
      return {
        selection: localCandidate,
        platformSpecific: []
      };
    }
  }

  // Fallback: prompt when there are multiple unique candidates
  if (force) {
    const selected = pickLatestByMtime(uniqueCandidates);
    logger.info(`Force-selected ${selected.displayPath} for ${group.registryPath}`);
    return {
      selection: selected,
      platformSpecific: []
    };
  }

  return await promptForCandidate(group.registryPath, uniqueCandidates);
}

function dedupeByHash(candidates: SaveCandidate[]): SaveCandidate[] {
  const seen = new Set<string>();
  const unique: SaveCandidate[] = [];

  for (const candidate of candidates) {
    if (seen.has(candidate.contentHash)) {
      continue;
    }
    seen.add(candidate.contentHash);
    unique.push(candidate);
  }

  return unique;
}

function pickLatestByMtime(candidates: SaveCandidate[]): SaveCandidate {
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i += 1) {
    const current = candidates[i];
    if (current.mtime > best.mtime) {
      best = current;
    }
  }
  return best;
}

async function promptForCandidate(
  registryPath: string,
  candidates: SaveCandidate[]
): Promise<SaveConflictResolution> {
  console.log(`\n⚠️  Conflict detected for ${registryPath}:`);
  candidates.forEach(candidate => {
    console.log(`  • ${formatCandidateLabel(candidate)}`);
  });

  // Stage 1: Allow marking workspace candidates as platform-specific when they advertise a platform
  const platformEligibleWorkspace = candidates.filter(
    candidate => candidate.source === 'workspace' && candidate.platform && candidate.platform !== 'ai'
  );
  let markedPlatformSpecific: SaveCandidate[] = [];

  if (platformEligibleWorkspace.length > 0) {
    const options = await Promise.all(
      platformEligibleWorkspace.map(async candidate => ({
        platform: candidate.platform ?? 'workspace',
        sourcePath: candidate.fullPath,
        preview: await getContentPreview(candidate.fullPath),
        registryPath: candidate.displayPath
      }))
    );

    const indices = await promptPlatformSpecificSelection(
      options,
      'Select workspace files to mark as platform-specific:',
      'Unselected files remain candidates for universal content'
    );

    const markedIndexSet = new Set<number>(indices);
    markedPlatformSpecific = platformEligibleWorkspace.filter((_, idx) => markedIndexSet.has(idx));
  }

  const markedSet = new Set(markedPlatformSpecific);

  // Stage 2: Choose universal from remaining (local + unmarked workspace)
  const local = candidates.find(candidate => candidate.source === 'local');
  const remainingWorkspace = candidates.filter(
    candidate => candidate.source === 'workspace' && !markedSet.has(candidate)
  );
  const universalChoices: SaveCandidate[] = [...(local ? [local] : []), ...remainingWorkspace];

  const resolvePlatformSpecific = (selection: SaveCandidate): SaveCandidate[] => {
    if (!markedSet.has(selection)) {
      return markedPlatformSpecific;
    }
    return markedPlatformSpecific.filter(candidate => candidate !== selection);
  };

  if (universalChoices.length === 0) {
    const fallbackSelection = candidates[0];
    return {
      selection: fallbackSelection,
      platformSpecific: resolvePlatformSpecific(fallbackSelection)
    };
  }

  if (universalChoices.length === 1) {
    const selection = universalChoices[0];
    return {
      selection,
      platformSpecific: resolvePlatformSpecific(selection)
    };
  }

  const response = await safePrompts({
    type: 'select',
    name: 'selectedIndex',
    message: `Choose universal content to save for ${registryPath}:`,
    choices: universalChoices.map((candidate, index) => ({
      title: formatCandidateLabel(candidate),
      value: index,
    })),
    hint: 'Use arrow keys to compare options and press Enter to select'
  });

  const selectedIndex = (response as any).selectedIndex as number;
  const selection = universalChoices[selectedIndex];
  return {
    selection,
    platformSpecific: resolvePlatformSpecific(selection)
  };
}

function formatCandidateLabel(candidate: SaveCandidate): string {
  const prefix = candidate.source === 'local' ? 'Formula' : 'Workspace';
  return `${prefix}: ${candidate.displayPath}`;
}

async function writeRootSelection(
  formulaDir: string,
  formulaName: string,
  localCandidate: SaveCandidate | undefined,
  selection: SaveCandidate
): Promise<void> {
  const targetPath = `${formulaDir}/${FILE_PATTERNS.AGENTS_MD}`;
  const sectionBody = (selection.sectionBody ?? selection.content).trim();
  const finalContent = sectionBody;

  try {
    if (await exists(targetPath)) {
      const existingContent = await readTextFile(targetPath, UTF8_ENCODING);
      if (existingContent === finalContent) {
        logger.debug(`Root file unchanged: ${FILE_PATTERNS.AGENTS_MD}`);
        return;
      }
    }

    await writeTextFile(targetPath, finalContent, UTF8_ENCODING);
    logger.debug(`Updated root file content for ${formulaName}`);
  } catch (error) {
    logger.warn(`Failed to write root file ${FILE_PATTERNS.AGENTS_MD}: ${error}`);
  }
}

/**
 * Check if a path is a YAML override file that should be included despite isAllowedRegistryPath filtering.
 * YAML override files are files like "rules/agent.claude.yml" that contain platform-specific frontmatter.
 */
function isYamlOverrideFileForSave(normalizedPath: string): boolean {
  // Must be skippable (which includes YAML override check) but not formula.yml
  return normalizedPath !== FILE_PATTERNS.FORMULA_YML && isSkippableRegistryPath(normalizedPath);
}

async function readFilteredLocalFormulaFiles(formulaDir: string): Promise<FormulaFile[]> {
  const entries = await findFilesByExtension(formulaDir, [], formulaDir);
  const files: FormulaFile[] = [];

  for (const entry of entries) {
    const normalizedPath = normalizeRegistryPath(entry.relativePath);
    if (normalizedPath === FORMULA_INDEX_FILENAME) continue;

    // Allow files that are either allowed by normal rules, root files, YAML override files,
    // or any root-level files adjacent to formula.yml (including formula.yml itself)
    const isAllowed = isAllowedRegistryPath(normalizedPath);
    const isRoot = isRootRegistryPath(normalizedPath);
    const isYamlOverride = isYamlOverrideFileForSave(normalizedPath);
    const isFormulaYml = normalizedPath === FILE_PATTERNS.FORMULA_YML;
    const isRootLevelFile = !normalizedPath.includes('/');

    if (!isAllowed && !isRoot && !isYamlOverride && !isFormulaYml && !isRootLevelFile) continue;

    const content = await readTextFile(entry.fullPath);
    files.push({
      path: normalizedPath,
      content,
      encoding: UTF8_ENCODING
    });
  }

  return files;
}


