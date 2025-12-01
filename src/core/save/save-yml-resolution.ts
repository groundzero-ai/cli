/**
 * Save YAML Frontmatter Resolution
 * Handles merging platform-specific frontmatter from workspace into universal files
 * and platform-specific override files during save operations.
 */

import { dirname, join } from 'path';
import * as yaml from 'js-yaml';
import { DIR_PATTERNS, FILE_PATTERNS } from '../../constants/index.js';
import { ensureDir, exists, readTextFile, writeTextFile } from '../../utils/fs.js';
import { getFileMtime } from '../../utils/file-processing.js';
import { safePrompts } from '../../utils/prompts.js';
import { logger } from '../../utils/logger.js';
import { SaveCandidate } from './save-types.js';
import {
  splitFrontmatter,
  dumpYaml,
  deepEqualYaml,
  subtractKeys,
  cloneYaml,
  composeMarkdown,
  normalizeFrontmatter,
  isPlainObject
} from '../../utils/markdown-frontmatter.js';
import { parseUniversalPath } from '../../utils/platform-file.js';
import { UTF8_ENCODING } from './constants.js';
import { deepMerge } from '../../utils/platform-yaml-merge.js';
import type { Platform } from '../platforms.js';

export interface SaveCandidateGroup {
  registryPath: string;
  local?: SaveCandidate;
  workspace: SaveCandidate[];
}

interface WorkspaceFrontmatterEntry {
  platform: Platform;
  candidate: SaveCandidate;
  frontmatter: Record<string, any>;
  markdownBody: string;
}

export interface OverrideResolution {
  platform: Platform;
  relativePath: string;
  workspaceFrontmatter?: any;
  workspaceMtime: number;
  localFrontmatter?: any;
  localMtime?: number;
  finalFrontmatter?: any;
  source: 'workspace' | 'local';
  hadConflict: boolean;
  effectiveFrontmatter: any;
}

export interface FrontmatterMergePlan {
  registryPath: string;
  workspaceEntries: WorkspaceFrontmatterEntry[];
  localUniversalFrontmatter?: Record<string, any>;
  platformOverrides: Map<Platform, any>;
  overrideDecisions?: Map<Platform, OverrideResolution>;
}


/**
 * Build frontmatter merge plans for all markdown files with platform-specific variants.
 * Uses the local universal frontmatter as the source of truth.
 */
export async function buildFrontmatterMergePlans(
  packageDir: string,
  groups: SaveCandidateGroup[]
): Promise<FrontmatterMergePlan[]> {
  const plans: FrontmatterMergePlan[] = [];

  for (const group of groups) {
    if (!group.registryPath.endsWith(FILE_PATTERNS.MD_FILES)) {
      continue;
    }

    // Only create merge plans for files that exist locally for this package
    // This prevents creating overrides for workspace-only files from other packages
    if (!group.local) {
      continue;
    }

    const universalPath = group.local.fullPath ?? join(packageDir, group.registryPath);
    if (!(await exists(universalPath))) {
      continue;
    }

    const platformMap = new Map<Platform, SaveCandidate>();
    for (const candidate of group.workspace) {
      if (!candidate.isMarkdown) continue;
      if (!candidate.platform || candidate.platform === 'ai') continue;

      const existing = platformMap.get(candidate.platform);
      if (!existing || candidate.mtime > existing.mtime) {
        platformMap.set(candidate.platform, candidate);
      }
    }

    if (platformMap.size === 0) {
      continue;
    }

    const workspaceEntries: WorkspaceFrontmatterEntry[] = [];
    for (const [platform, candidate] of platformMap.entries()) {
      const normalizedFrontmatter = normalizeFrontmatter(candidate.frontmatter);
      const markdownBody = candidate.markdownBody ?? candidate.content;
      workspaceEntries.push({
        platform,
        candidate,
        frontmatter: normalizedFrontmatter,
        markdownBody
      });
    }

    const localUniversalFrontmatter = group.local.frontmatter
      ? normalizeFrontmatter(group.local.frontmatter)
      : {};
    const platformOverrides = new Map<Platform, any>();

    for (const entry of workspaceEntries) {
      const base = cloneYaml(entry.frontmatter);
      const override =
        Object.keys(localUniversalFrontmatter).length > 0
          ? subtractKeys(base, localUniversalFrontmatter)
          : base;
      const normalizedOverride =
        override && (!isPlainObject(override) || Object.keys(override).length > 0)
          ? override
          : undefined;
      platformOverrides.set(entry.platform, normalizedOverride);
    }

    plans.push({
      registryPath: group.registryPath,
      workspaceEntries,
      localUniversalFrontmatter:
        localUniversalFrontmatter && Object.keys(localUniversalFrontmatter).length > 0
          ? cloneYaml(localUniversalFrontmatter)
          : undefined,
      platformOverrides
    });
  }

  return plans;
}

/**
 * Compute shared frontmatter keys that are identical across all workspace entries.
 */
function computeSharedFrontmatter(entries: WorkspaceFrontmatterEntry[]): Record<string, any> | undefined {
  if (entries.length === 0) {
    return undefined;
  }

  let shared: Record<string, any> | undefined = cloneYaml(entries[0].frontmatter);

  for (let i = 1; i < entries.length; i += 1) {
    if (!shared) {
      break;
    }
    shared = intersectFrontmatter(shared, entries[i].frontmatter);
  }

  if (!shared || Object.keys(shared).length === 0) {
    return undefined;
  }

  return shared;
}

/**
 * Intersect two frontmatter objects, keeping only keys with matching values.
 */
function intersectFrontmatter(
  base: Record<string, any>,
  other: Record<string, any>
): Record<string, any> | undefined {
  const result: Record<string, any> = {};

  for (const key of Object.keys(base)) {
    if (!Object.prototype.hasOwnProperty.call(other, key)) {
      continue;
    }

    const baseValue = base[key];
    const otherValue = other[key];

    if (isPlainObject(baseValue) && isPlainObject(otherValue)) {
      const nested = intersectFrontmatter(baseValue, otherValue);
      if (nested && Object.keys(nested).length > 0) {
        result[key] = nested;
      }
      continue;
    }

    if (Array.isArray(baseValue) && Array.isArray(otherValue)) {
      if (deepEqualYaml(baseValue, otherValue)) {
        result[key] = cloneYaml(baseValue);
      }
      continue;
    }

    if (deepEqualYaml(baseValue, otherValue)) {
      result[key] = cloneYaml(baseValue);
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Get the relative path for a platform-specific override file.
 */
export function getOverrideRelativePath(registryPath: string, platform: Platform): string | null {
  const parsed = parseUniversalPath(registryPath, { allowPlatformSuffix: false });
  if (!parsed) {
    return null;
  }

  const base = parsed.relPath.replace(/\.md$/, '');
  return `${DIR_PATTERNS.OPENPACKAGE}/${parsed.universalSubdir}/${base}.${platform}.yml`;
}

/**
 * Resolve override decisions for each platform, handling conflicts based on mtime.
 */
export async function resolveOverrideDecisions(
  packageDir: string,
  plan: FrontmatterMergePlan
): Promise<Map<Platform, OverrideResolution>> {
  const resolutions = new Map<Platform, OverrideResolution>();

  for (const entry of plan.workspaceEntries) {
    const platform = entry.platform;
    const relativePath = getOverrideRelativePath(plan.registryPath, platform);
    if (!relativePath) {
      continue;
    }

    const workspaceOverride = plan.platformOverrides.get(platform);
    const workspaceFrontmatter =
      workspaceOverride && isPlainObject(workspaceOverride)
        ? cloneYaml(workspaceOverride)
        : workspaceOverride;
    const workspaceMtime = entry.candidate.mtime;

    const absolutePath = join(packageDir, relativePath);
    let localFrontmatter: any;
    let localMtime: number | undefined;

    if (await exists(absolutePath)) {
      try {
        const localContent = await readTextFile(absolutePath);
        const parsed = yaml.load(localContent) ?? {};
        localFrontmatter = normalizeFrontmatter(parsed);
      } catch (error) {
        logger.warn(`Failed to parse local override ${relativePath}: ${error}`);
        localFrontmatter = {};
      }

      try {
        localMtime = await getFileMtime(absolutePath);
      } catch (error) {
        logger.warn(`Failed to get mtime for override ${relativePath}: ${error}`);
      }
    } else {
      localFrontmatter = undefined;
    }

    const normalizedLocal =
      localFrontmatter && (!isPlainObject(localFrontmatter) || Object.keys(localFrontmatter).length > 0)
        ? localFrontmatter
        : undefined;

    const normalizedWorkspace =
      workspaceFrontmatter && (!isPlainObject(workspaceFrontmatter) || Object.keys(workspaceFrontmatter).length > 0)
        ? workspaceFrontmatter
        : undefined;

    // Deep-merge-based equality: compare merged results (base + override)
    // This matches the runtime behavior of mergePlatformYamlOverride
    const baseForMerge = plan.localUniversalFrontmatter
      ? cloneYaml(plan.localUniversalFrontmatter)
      : {};
    const mergedWorkspace = deepMerge(cloneYaml(baseForMerge), normalizedWorkspace ?? {});
    const mergedLocal = deepMerge(cloneYaml(baseForMerge), normalizedLocal ?? {});
    const differs = !deepEqualYaml(mergedWorkspace, mergedLocal);
    const hadConflict = differs && normalizedLocal !== undefined;
    let finalFrontmatter = normalizedWorkspace;
    let source: 'workspace' | 'local' = 'workspace';
    let effectiveFrontmatter = mergedWorkspace;

    if (differs && normalizedLocal !== undefined) {
      if (localMtime !== undefined && workspaceMtime > localMtime) {
        const decision = await promptYamlOverrideDecision(
          platform,
          plan.registryPath,
          entry.candidate.displayPath,
          relativePath,
        );
        if (decision === 'local') {
          finalFrontmatter = normalizedLocal;
          source = 'local';
          effectiveFrontmatter = mergedLocal;
        }
      } else if (localMtime !== undefined && localMtime >= workspaceMtime) {
        finalFrontmatter = normalizedLocal;
        source = 'local';
        effectiveFrontmatter = mergedLocal;
      } else if (localMtime === undefined) {
        // SAFETY: If we cannot determine mtime, preserve local data.
        // The workspace local cache is the source of truth - when in doubt, don't discard it.
        logger.debug(
          `Unable to determine mtime for override ${relativePath}, preserving local data as source of truth`
        );
        finalFrontmatter = normalizedLocal;
        source = 'local';
        effectiveFrontmatter = mergedLocal;
      }
    } else if (normalizedLocal !== undefined && normalizedWorkspace === undefined) {
      finalFrontmatter = normalizedLocal;
      source = 'local';
      effectiveFrontmatter = mergedLocal;
    }

    resolutions.set(platform, {
      platform,
      relativePath,
      workspaceFrontmatter: normalizedWorkspace,
      workspaceMtime,
      localFrontmatter: normalizedLocal,
      localMtime,
      finalFrontmatter,
      source,
      hadConflict,
      effectiveFrontmatter
    });
  }

  return resolutions;
}

/**
 * Prompt user to choose between workspace and local override when workspace is newer.
 */
async function promptYamlOverrideDecision(
  platform: Platform,
  registryPath: string,
  workspaceFilePath: string,
  packageFilePath: string,
): Promise<'workspace' | 'local'> {
  const response = await safePrompts({
    type: 'select',
    name: 'choice',
    message: `Keep YAML override for ${platform} on ${registryPath}`,
    choices: [
      {
        title: `Workspace (${workspaceFilePath})`,
        value: 'workspace',
      },
      {
        title: `Package (${packageFilePath})`,
        value: 'local',
      }
    ]
  });

  return (response as any).choice as 'workspace' | 'local';
}

/**
 * Apply frontmatter merge plans: resolve conflicts, update universal files, and write overrides.
 */
export async function applyFrontmatterMergePlans(
  packageDir: string,
  plans: FrontmatterMergePlan[]
): Promise<void> {
  for (const plan of plans) {
    const overrideDecisions = await resolveOverrideDecisions(packageDir, plan);
    plan.overrideDecisions = overrideDecisions;
    const hasConflicts = Array.from(overrideDecisions.values()).some(
      resolution => resolution.hadConflict
    );

    if (!hasConflicts) {
      await updateUniversalMarkdown(packageDir, plan);
    }
    await applyOverrideFiles(packageDir, plan);
  }
}

/**
 * Update the universal markdown file with computed universal frontmatter.
 */
async function updateUniversalMarkdown(
  packageDir: string,
  plan: FrontmatterMergePlan
): Promise<void> {
  const universalPath = join(packageDir, plan.registryPath);

  if (!(await exists(universalPath))) {
    return;
  }

  const originalContent = await readTextFile(universalPath);
  const split = splitFrontmatter(originalContent);
  const desiredFrontmatter = computeSharedFrontmatter(plan.workspaceEntries);
  const updatedContent = composeMarkdown(desiredFrontmatter, split.body);

  if (updatedContent !== originalContent) {
    await writeTextFile(universalPath, updatedContent, UTF8_ENCODING);
  }
}

/**
 * Apply platform-specific override files based on resolved decisions.
 */
async function applyOverrideFiles(
  packageDir: string,
  plan: FrontmatterMergePlan
): Promise<void> {
  if (!plan.overrideDecisions) {
    return;
  }

  // Safety check: don't write overrides unless the universal file exists locally
  // This prevents creating override files for files that don't belong to this package
  const universalPath = join(packageDir, plan.registryPath);
  if (!(await exists(universalPath))) {
    return;
  }

  const universalContent = await readTextFile(universalPath);
  const universalSplit = splitFrontmatter(universalContent);
  const diskUniversalFrontmatter =
    universalSplit.frontmatter !== null
      ? normalizeFrontmatter(universalSplit.frontmatter)
      : {};

  for (const resolution of plan.overrideDecisions.values()) {
    const overridePath = join(packageDir, resolution.relativePath);
    const { hadConflict, source, effectiveFrontmatter } = resolution;

    // Start from the resolved override (may be workspace or local)
    const selectedFrontmatter = effectiveFrontmatter ?? {};

    // Only when there was a YAML conflict AND user explicitly chose "Workspace",
    // we should update the .yml file even if workspace override is empty.
    // This ensures the local override is replaced with the workspace state.
    const overrideDiff = subtractKeys(cloneYaml(selectedFrontmatter), diskUniversalFrontmatter);

    const normalizedOverride =
      overrideDiff && (!isPlainObject(overrideDiff) || Object.keys(overrideDiff).length > 0)
        ? overrideDiff
        : undefined;

    const userChoseWorkspaceInConflict = hadConflict && source === 'workspace';

    if (normalizedOverride === undefined) {
      if (userChoseWorkspaceInConflict) {
        await ensureDir(dirname(overridePath));
        const emptyYaml = '{}\n';
        if ((await exists(overridePath)) && (await readTextFile(overridePath)) === emptyYaml) {
          continue;
        }
        await writeTextFile(overridePath, emptyYaml, UTF8_ENCODING);
        continue;
      }

      if (await exists(overridePath)) {
        logger.debug(
          `Preserving existing override file (computed frontmatter is empty): ${resolution.relativePath}`
        );
      }
      continue;
    }

    await ensureDir(dirname(overridePath));
    const yamlContent = `${dumpYaml(normalizedOverride)}\n`;
    if ((await exists(overridePath)) && (await readTextFile(overridePath)) === yamlContent) {
      continue;
    }
    await writeTextFile(overridePath, yamlContent, UTF8_ENCODING);
  }
}

