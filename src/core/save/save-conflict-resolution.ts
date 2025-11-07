import type { FormulaFile } from '../../types/index.js';
import type { FormulaYmlInfo } from './formula-yml-generator.js';
import { FILE_PATTERNS } from '../../constants/index.js';
import { FORMULA_INDEX_FILENAME } from '../../utils/formula-index-yml.js';
import { getLocalFormulaDir } from '../../utils/paths.js';
import { exists, isDirectory, readTextFile, writeTextFile } from '../../utils/fs.js';
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
import { safePrompts } from '../../utils/prompts.js';
import { logger } from '../../utils/logger.js';
import { buildOpenMarker, CLOSE_MARKER } from '../../utils/root-file-extractor.js';
import { generateEntityId } from '../../utils/entity-id.js';
import { SaveCandidate } from './save-candidate-types.js';
import {
  discoverWorkspaceRootSaveCandidates,
  loadLocalRootSaveCandidates
} from './root-save-candidates.js';

interface SaveCandidateGroup {
  registryPath: string;
  local?: SaveCandidate;
  workspace: SaveCandidate[];
}

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
  const workspaceCandidates = [...workspacePlatformCandidates, ...workspaceRootCandidates];

  const groups = buildCandidateGroups(localCandidates, workspaceCandidates);

  // Resolve conflicts and write chosen content back to local files
  for (const group of groups) {
    // Only consider as conflict if local exists AND there is at least one differing workspace candidate
    const hasLocal = !!group.local;
    const hasDifferingWorkspace = group.workspace.some(w => w.contentHash !== group.local?.contentHash);

    if (!hasLocal || !hasDifferingWorkspace) {
      continue;
    }

    const selection = await resolveGroup(group, options.force ?? false);
    if (!selection) continue;

    if (group.registryPath === FILE_PATTERNS.AGENTS_MD && selection.isRootFile) {
      await writeRootSelection(formulaDir, formulaInfo.config.name, group.local, selection);
      continue;
    }

    if (selection.contentHash !== group.local!.contentHash) {
      // Overwrite local file content with selected content
      const targetPath = `${formulaDir}/${group.registryPath}`;
      try {
        await writeTextFile(targetPath, selection.content, UTF8_ENCODING);
        logger.debug(`Updated local file with selected content: ${group.registryPath}`);
      } catch (error) {
        logger.warn(`Failed to write selected content to ${group.registryPath}: ${error}`);
      }
    }
  }

  // After resolving conflicts by updating local files, simply read filtered files from local dir
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
    const contentHash = await calculateFileHash(content);
    const mtime = await getFileMtime(fullPath);

    candidates.push({
      source: 'local',
      registryPath: normalizedPath,
      fullPath,
      content,
      contentHash,
      mtime,
      displayPath: normalizedPath
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
    const contentHash = await calculateFileHash(content);
    const displayPath = getRelativePathFromBase(file.fullPath, cwd) || normalizedPath;

    candidates.push({
      source: 'workspace',
      registryPath: normalizedPath,
      fullPath: file.fullPath,
      content,
      contentHash,
      mtime: file.mtime,
      displayPath
    });
  }

  return candidates;
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

async function resolveGroup(group: SaveCandidateGroup, force: boolean): Promise<SaveCandidate | undefined> {
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

  if (group.local) {
    const workspaceHashes = new Set(group.workspace.map(candidate => candidate.contentHash));
    const localCandidate = group.local;
    const localIsOnlyChanged = workspaceHashes.size === 1 && !workspaceHashes.has(localCandidate.contentHash);

    if (localIsOnlyChanged) {
      const localHasGreatestMtime = orderedCandidates.every(candidate =>
        candidate === localCandidate || localCandidate.mtime > candidate.mtime
      );

      if (localHasGreatestMtime) {
        return localCandidate;
      }
    }
  }

  const uniqueCandidates = dedupeByHash(orderedCandidates);

  if (uniqueCandidates.length === 1) {
    return uniqueCandidates[0];
  }

  if (force) {
    const selected = pickLatestByMtime(uniqueCandidates);
    logger.info(`Force-selected ${selected.displayPath} for ${group.registryPath}`);
    return selected;
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
): Promise<SaveCandidate> {
  console.log(`\n⚠️  Conflict detected for ${registryPath}:`);
  candidates.forEach(candidate => {
    console.log(`  • ${formatCandidateLabel(candidate)} (mtime ${formatTimestamp(candidate.mtime)})`);
  });

  const response = await safePrompts({
    type: 'select',
    name: 'selectedIndex',
    message: `Choose content to save for ${registryPath}:`,
    choices: candidates.map((candidate, index) => ({
      title: formatCandidateLabel(candidate),
      value: index,
      description: createCandidatePreview(candidate.content)
    })),
    hint: 'Use arrow keys to compare options and press Enter to select'
  });

  const selectedIndex = (response as any).selectedIndex as number;
  return candidates[selectedIndex];
}

function formatCandidateLabel(candidate: SaveCandidate): string {
  const prefix = candidate.source === 'local' ? 'Local cache' : 'Workspace';
  return `${prefix}: ${candidate.displayPath}`;
}

function createCandidatePreview(content: string): string {
  const compact = content.replace(/\s+/g, ' ').trim();
  return compact.length > 100 ? `${compact.slice(0, 100)}…` : compact;
}

function formatTimestamp(mtime: number): string {
  return new Date(mtime).toISOString();
}

async function writeRootSelection(
  formulaDir: string,
  formulaName: string,
  localCandidate: SaveCandidate | undefined,
  selection: SaveCandidate
): Promise<void> {
  const targetPath = `${formulaDir}/${FILE_PATTERNS.AGENTS_MD}`;
  const sectionBody = (selection.sectionBody ?? selection.content).trim();
  const markerId = localCandidate?.markerId ?? selection.markerId ?? generateEntityId();
  const finalContent = `${buildOpenMarker(formulaName, markerId)}\n${sectionBody}\n${CLOSE_MARKER}\n`;

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


