/**
 * Save YAML Frontmatter Resolution
 * Handles merging platform-specific frontmatter from workspace into universal files
 * and platform-specific override files during save operations.
 */

import { join } from 'path';
import * as yaml from 'js-yaml';
import { FILE_PATTERNS, PLATFORMS, PLATFORM_DIRS, type Platform } from '../../constants/index.js';
import { exists, readTextFile, writeTextFile, remove } from '../../utils/fs.js';
import { getFileMtime } from '../../utils/file-processing.js';
import { safePrompts } from '../../utils/prompts.js';
import { logger } from '../../utils/logger.js';
import { SaveCandidate } from './save-candidate-types.js';
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
}

export interface FrontmatterMergePlan {
  registryPath: string;
  workspaceEntries: WorkspaceFrontmatterEntry[];
  universalFrontmatter?: Record<string, any>;
  platformOverrides: Map<Platform, any>;
  overrideDecisions?: Map<Platform, OverrideResolution>;
}


/**
 * Build frontmatter merge plans for all markdown files with platform-specific variants.
 */
export function buildFrontmatterMergePlans(groups: SaveCandidateGroup[]): FrontmatterMergePlan[] {
  const plans: FrontmatterMergePlan[] = [];

  for (const group of groups) {
    if (!group.registryPath.endsWith(FILE_PATTERNS.MD_FILES)) {
      continue;
    }

    // Only create merge plans for files that exist locally for this formula
    // This prevents creating overrides for workspace-only files from other formulas
    if (!group.local) {
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

    const universalFrontmatter = computeSharedFrontmatter(workspaceEntries);
    const platformOverrides = new Map<Platform, any>();

    for (const entry of workspaceEntries) {
      const base = cloneYaml(entry.frontmatter);
      const override = universalFrontmatter ? subtractKeys(base, universalFrontmatter) : base;
      const normalizedOverride =
        override && (!isPlainObject(override) || Object.keys(override).length > 0)
          ? override
          : undefined;
      platformOverrides.set(entry.platform, normalizedOverride);
    }

    plans.push({
      registryPath: group.registryPath,
      workspaceEntries,
      universalFrontmatter: universalFrontmatter && Object.keys(universalFrontmatter).length > 0 ? universalFrontmatter : undefined,
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
function getOverrideRelativePath(registryPath: string, platform: Platform): string | null {
  const parsed = parseUniversalPath(registryPath, { allowPlatformSuffix: false });
  if (!parsed) {
    return null;
  }

  const base = parsed.relPath.replace(/\.md$/, '');
  return `${parsed.universalSubdir}/${base}.${platform}.yml`;
}

/**
 * Resolve override decisions for each platform, handling conflicts based on mtime.
 */
export async function resolveOverrideDecisions(
  formulaDir: string,
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

    const absolutePath = join(formulaDir, relativePath);
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

    const adjustedLocal =
      localFrontmatter && plan.universalFrontmatter
        ? subtractKeys(cloneYaml(localFrontmatter), plan.universalFrontmatter)
        : localFrontmatter;

    const normalizedLocal =
      adjustedLocal && (!isPlainObject(adjustedLocal) || Object.keys(adjustedLocal).length > 0)
        ? adjustedLocal
        : undefined;

    const normalizedWorkspace =
      workspaceFrontmatter && (!isPlainObject(workspaceFrontmatter) || Object.keys(workspaceFrontmatter).length > 0)
        ? workspaceFrontmatter
        : undefined;

    // Deep-merge-based equality: compare merged results (base + override)
    // This matches the runtime behavior of mergePlatformYamlOverride
    const baseForMerge = plan.universalFrontmatter ? cloneYaml(plan.universalFrontmatter) : {};
    const mergedWorkspace = deepMerge(cloneYaml(baseForMerge), normalizedWorkspace ?? {});
    const mergedLocal = deepMerge(cloneYaml(baseForMerge), normalizedLocal ?? {});
    const differs = !deepEqualYaml(mergedWorkspace, mergedLocal);
    let finalFrontmatter = normalizedWorkspace;
    let source: 'workspace' | 'local' = 'workspace';

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
        }
      } else if (localMtime !== undefined && localMtime >= workspaceMtime) {
        finalFrontmatter = normalizedLocal;
        source = 'local';
      }
    } else if (normalizedLocal !== undefined && normalizedWorkspace === undefined) {
      finalFrontmatter = normalizedLocal;
      source = 'local';
    }

    resolutions.set(platform, {
      platform,
      relativePath,
      workspaceFrontmatter: normalizedWorkspace,
      workspaceMtime,
      localFrontmatter: normalizedLocal,
      localMtime,
      finalFrontmatter,
      source
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
  formulaFilePath: string,
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
        title: `Package (${formulaFilePath})`,
        value: 'local',
      }
    ]
  });

  return (response as any).choice as 'workspace' | 'local';
}

/**
 * Create a preview string from YAML data for display in prompts.
 */
function createYamlPreview(data: any): string {
  if (!data || (isPlainObject(data) && Object.keys(data).length === 0)) {
    return '[empty]';
  }

  const yamlText = dumpYaml(data);
  const lines = yamlText.split('\n');
  if (lines.length <= 5) {
    return yamlText;
  }
  return `${lines.slice(0, 5).join('\n')}…`;
}

/**
 * Apply frontmatter merge plans: resolve conflicts, update universal files, and write overrides.
 */
export async function applyFrontmatterMergePlans(
  formulaDir: string,
  plans: FrontmatterMergePlan[]
): Promise<void> {
  for (const plan of plans) {
    plan.overrideDecisions = await resolveOverrideDecisions(formulaDir, plan);
    await updateUniversalMarkdown(formulaDir, plan);
    await applyOverrideFiles(formulaDir, plan);
  }
}

/**
 * Update the universal markdown file with computed universal frontmatter.
 */
async function updateUniversalMarkdown(
  formulaDir: string,
  plan: FrontmatterMergePlan
): Promise<void> {
  const universalPath = join(formulaDir, plan.registryPath);

  if (!(await exists(universalPath))) {
    return;
  }

  const originalContent = await readTextFile(universalPath);
  const split = splitFrontmatter(originalContent);
  const desiredFrontmatter =
    plan.universalFrontmatter && Object.keys(plan.universalFrontmatter).length > 0
      ? cloneYaml(plan.universalFrontmatter)
      : undefined;
  const updatedContent = composeMarkdown(desiredFrontmatter, split.body);

  if (updatedContent !== originalContent) {
    await writeTextFile(universalPath, updatedContent, UTF8_ENCODING);
  }
}

/**
 * Apply platform-specific override files based on resolved decisions.
 */
async function applyOverrideFiles(
  formulaDir: string,
  plan: FrontmatterMergePlan
): Promise<void> {
  if (!plan.overrideDecisions) {
    return;
  }

  // Safety check: don't write overrides unless the universal file exists locally
  // This prevents creating override files for files that don't belong to this formula
  const universalPath = join(formulaDir, plan.registryPath);
  if (!(await exists(universalPath))) {
    return;
  }

  for (const resolution of plan.overrideDecisions.values()) {
    const overridePath = join(formulaDir, resolution.relativePath);
    const finalFrontmatter = resolution.finalFrontmatter;

    if (finalFrontmatter === undefined) {
      if (await exists(overridePath)) {
        await remove(overridePath);
      }
      continue;
    }

    const yamlContent = `${dumpYaml(finalFrontmatter)}\n`;
    if ((await exists(overridePath)) && (await readTextFile(overridePath)) === yamlContent) {
      continue;
    }
    await writeTextFile(overridePath, yamlContent, UTF8_ENCODING);
  }
}

