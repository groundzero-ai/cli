/**
 * Platform YAML Merge Utility
 * Reusable helper to merge platform-specific YAML frontmatter overrides
 * into universal markdown content.
 */

import { FILE_PATTERNS, PLATFORMS, UNIVERSAL_SUBDIRS, type Platform } from '../constants/index.js';
import type { FormulaFile } from '../types/index.js';
import { formulaManager } from '../core/formula.js';
import * as yaml from 'js-yaml';

function isPlainObject(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base: any, override: any): any {
  if (Array.isArray(base) && Array.isArray(override)) {
    return override.slice();
  }

  if (isPlainObject(base) && isPlainObject(override)) {
    const result: Record<string, any> = { ...base };
    for (const [key, value] of Object.entries(override)) {
      if (key in result) {
        result[key] = deepMerge(result[key], value);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  if (override !== undefined) {
    return override;
  }

  return base;
}

interface ParsedFrontmatter {
  data: Record<string, any>;
  body: string;
  hadFrontmatter: boolean;
}

function parseFrontmatter(content: string): ParsedFrontmatter {
  const frontmatterRegex = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
  const match = frontmatterRegex.exec(content);

  if (!match) {
    return { data: {}, body: content, hadFrontmatter: false };
  }

  const yamlSource = match[1];
  const body = content.slice(match[0].length);

  try {
    const parsed = yaml.load(yamlSource);
    if (isPlainObject(parsed)) {
      return { data: parsed, body, hadFrontmatter: true };
    }
  } catch {
    // Fall through to return empty data
  }

  return { data: {}, body, hadFrontmatter: true };
}

function formatWithFrontmatter(data: Record<string, any>, body: string): string {
  const frontmatterYaml = yaml.dump(data, {
    indent: 2,
    noArrayIndent: true,
    sortKeys: false,
    quotingType: '"'
  }).trim();

  const header = `---\n${frontmatterYaml}\n---`;

  if (!body) {
    return `${header}\n`;
  }

  if (body.startsWith('\n') || body.startsWith('\r')) {
    return `${header}${body}`;
  }

  return `${header}\n${body}`;
}

/**
 * Merge platform-specific YAML override with universal content.
 *
 * - Only acts on markdown files (relPath must end with .md)
 * - Looks for `{universalSubdir}/{base}.{platform}.yml` in the provided files
 * - If found, merges YAML (non-formula) before the formula block
 * - Returns original content if no matching override
 */
export function mergePlatformYamlOverride(
  universalContent: string,
  targetPlatform: Platform,
  universalSubdir: string,
  relPath: string,
  formulaFiles: FormulaFile[]
): string {
  try {
    if (!relPath.endsWith(FILE_PATTERNS.MD_FILES)) return universalContent;

    const base = relPath.slice(0, -FILE_PATTERNS.MD_FILES.length);
    const overridePath = `${universalSubdir}/${base}.${targetPlatform}.yml`;
    const matchingYml = formulaFiles.find(f => f.path === overridePath);

    if (!matchingYml?.content?.trim()) {
      return universalContent;
    }

    let overrideData: Record<string, any>;
    try {
      const parsedOverride = yaml.load(matchingYml.content);
      if (!isPlainObject(parsedOverride)) {
        console.warn(`YAML override for ${overridePath} must be an object; received ${typeof parsedOverride}`);
        return universalContent;
      }
      overrideData = parsedOverride;
    } catch (error) {
      console.warn(`Failed to parse YAML override for ${overridePath}: ${error}`);
      return universalContent;
    }

    if (Object.keys(overrideData).length === 0) {
      return universalContent;
    }

    const { data: baseData, body, hadFrontmatter } = parseFrontmatter(universalContent);
    const mergedData = deepMerge(baseData, overrideData);

    // Avoid reformatting if there's no change compared to base.
    if (hadFrontmatter && JSON.stringify(baseData) === JSON.stringify(mergedData)) {
      return universalContent;
    }

    return formatWithFrontmatter(mergedData, body);
  } catch {
    return universalContent;
  }
}

/**
 * Load platform-specific YAML override files from the registry for a formula version.
 * Matches files in universal subdirs with pattern: "{subdir}/{base}.{platform}.yml"
 */
export async function loadRegistryYamlOverrides(
  formulaName: string,
  version: string
): Promise<FormulaFile[]> {
  const overrides: FormulaFile[] = [];

  // Load formula from registry
  const formula = await formulaManager.loadFormula(formulaName, version);

  // Known platforms for suffix matching
  const platformValues: string[] = Object.values(PLATFORMS as Record<string, string>);
  const subdirs: string[] = Object.values(UNIVERSAL_SUBDIRS as Record<string, string>);

  for (const file of formula.files) {
    const path = file.path;
    // Must be in a universal subdir
    if (!subdirs.some(sd => path.startsWith(sd + '/'))) continue;
    // Must end with .yml and have a platform suffix before it
    if (!path.endsWith(FILE_PATTERNS.YML_FILE)) continue;

    const lastDot = path.lastIndexOf('.');
    const secondLastDot = path.lastIndexOf('.', lastDot - 1);
    if (secondLastDot === -1) continue;
    const possiblePlatform = path.slice(secondLastDot + 1, lastDot);
    if (!platformValues.includes(possiblePlatform)) continue;

    overrides.push({ path: file.path, content: file.content, encoding: 'utf8' });
  }

  return overrides;
}


