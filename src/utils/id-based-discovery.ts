/**
 * ID-based Discovery Utilities
 * Provides functions for scanning, mapping, and resolving files by their frontmatter IDs
 * for platform-specific markdown files during installation.
 */

import { join, dirname, basename } from 'path';
import { exists, readTextFile, remove } from './fs.js';
import { parseMarkdownFrontmatter } from './md-frontmatter.js';
import { isValidEntityId } from './entity-id.js';
import { logger } from './logger.js';
import { formulaManager } from '../core/formula.js';
import { getPlatformDefinition } from '../core/platforms.js';
import { UNIVERSAL_SUBDIRS, FILE_PATTERNS, PLATFORM_DIRS, type Platform } from '../constants/index.js';
import { findFilesByExtension } from './discovery/file-processing.js';
import type { FileIdInfo, FormulaFile } from '../types/index.js';
import { areFormulaNamesEquivalent } from './formula-name.js';

/**
 * Information about a registry file with its ID and adjacent files
 */
export interface RegistryFileInfo {
  id: string | null;
  registryPath: string;
  content: string;
  parentDir: string;
  fileName: string;
  adjacentIds: string[]; // IDs of other files in the same parent directory
}

/**
 * Result of scanning cwd for files with IDs
 */
export interface CwdIdMapEntry {
  fullPath: string;
  fileName: string;
  formulaName: string;
  id: string;
  isValid: boolean;
  platform: string;
}

/**
 * Build a map of file IDs to file info for all markdown files in cwd platform directories
 * that have formula frontmatter matching the specified formula name.
 */
export async function buildCwdIdMap(
  cwd: string,
  platforms: Platform[],
  formulaName: string
): Promise<Map<string, CwdIdMapEntry[]>> {
  const idMap = new Map<string, CwdIdMapEntry[]>();

  // Helper to process a discovered file by full path
  const processFile = async (filePath: string, platformLabel: string): Promise<void> => {
    try {
      const content = await readTextFile(filePath);
      const frontmatter = parseMarkdownFrontmatter(content);

      if (frontmatter?.formula?.name && areFormulaNamesEquivalent(frontmatter.formula.name, formulaName)) {
        const id = frontmatter.formula.id;
        const isValid = id && isValidEntityId(id);

        logger.debug(`Found file ${filePath} with formula name ${formulaName}, ID: ${id}, isValid: ${!!isValid}`);

        if (id && isValid) {
          const existing = idMap.get(id) || [];
          if (existing.some(e => e.platform === platformLabel)) {
            logger.warn(`Duplicate ID detected '${id}' for platform '${platformLabel}' at ${filePath}; keeping first occurrence`);
            idMap.set(id, existing);
            return;
          }
          const entry: CwdIdMapEntry = {
            fullPath: filePath,
            fileName: basename(filePath),
            formulaName,
            id,
            isValid: true,
            platform: platformLabel
          };
          idMap.set(id, [...existing, entry]);
          logger.debug(`Added ID ${id} to cwd map for file ${basename(filePath)} (platform: ${platformLabel})`);
        }
      }
    } catch (error) {
      logger.warn(`Failed to read file ${filePath}: ${error}`);
    }
  };

  // 1) Scan AI directory for formula-marked markdown files
  const aiDir = join(cwd, PLATFORM_DIRS.AI);
  if (await exists(aiDir)) {
    const aiFiles = await findFilesByExtension(aiDir);
    await Promise.all(aiFiles.map(f => processFile(f.fullPath, PLATFORM_DIRS.AI)));
  }

  // 2) Scan all detected platform subdirectories (rules/commands/agents)
  for (const platform of platforms) {
    const platformDef = getPlatformDefinition(platform);

    for (const [, subdirDef] of Object.entries(platformDef.subdirs)) {
      const subdirPath = join(cwd, platformDef.rootDir, subdirDef.path);

      if (!(await exists(subdirPath))) {
        continue;
      }

      const patterns = subdirDef.readExts && subdirDef.readExts.length > 0 ? subdirDef.readExts : [FILE_PATTERNS.MD_FILES];

      // Find files for each supported extension in this subdir
      const files = await findFilesByExtension(subdirPath, patterns);
      await Promise.all(files.map(f => processFile(f.fullPath, platformDef.id)));
    }
  }

  return idMap;
}

/**
 * Build a map of registry files with their IDs and adjacent file information
 * for platform-specific markdown files in the formula.
 */
export async function buildRegistryIdMap(
  formulaName: string,
  version: string
): Promise<Map<string, RegistryFileInfo>> {
  const registryMap = new Map<string, RegistryFileInfo>();
  
  // Load formula from registry
  const formula = await formulaManager.loadFormula(formulaName, version);
  
  // Filter to ALL markdown files with valid entity IDs
  const platformFiles = formula.files.filter(file => {
    const path = file.path;
    if (!path.endsWith(FILE_PATTERNS.MD_FILES)) return false;

    // Check if file has a valid entity ID
    const frontmatter = parseMarkdownFrontmatter(file.content);
    const id = frontmatter?.formula?.id;
    return id && isValidEntityId(id);
  });
  
  // Group files by parent directory to identify adjacent files
  const filesByDir = new Map<string, string[]>();
  
  for (const file of platformFiles) {
    const parentDir = dirname(file.path);
    
    if (!filesByDir.has(parentDir)) {
      filesByDir.set(parentDir, []);
    }
    
    // Extract ID from content
    const frontmatter = parseMarkdownFrontmatter(file.content);
    const id = frontmatter?.formula?.id;
    
    if (id && isValidEntityId(id)) {
      filesByDir.get(parentDir)!.push(id);
    }
  }
  
  // Build the registry map with adjacent ID information
  for (const file of platformFiles) {
    const parentDir = dirname(file.path);
    const frontmatter = parseMarkdownFrontmatter(file.content);
    const id = frontmatter?.formula?.id || null;
    
    logger.debug(`Registry file ${basename(file.path)} has ID: ${id}, parentDir: ${parentDir}`);
    
    registryMap.set(file.path, {
      id,
      registryPath: file.path,
      content: file.content,
      parentDir,
      fileName: basename(file.path),
      adjacentIds: filesByDir.get(parentDir) || []
    });
  }
  
  return registryMap;
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
  const { PLATFORMS, UNIVERSAL_SUBDIRS } = await import('../constants/index.js');
  const platformValues: string[] = Object.values(PLATFORMS as Record<string, string>);
  const subdirs: string[] = Object.values(UNIVERSAL_SUBDIRS as Record<string, string>);

  for (const file of formula.files) {
    const path = file.path;
    // Must be in a universal subdir
    if (!subdirs.some(sd => path.startsWith(sd + '/'))) continue;
    // Must end with .yml and have a platform suffix before it
    if (!path.endsWith('.yml')) continue;

    const lastDot = path.lastIndexOf('.');
    const secondLastDot = path.lastIndexOf('.', lastDot - 1);
    if (secondLastDot === -1) continue;
    const possiblePlatform = path.slice(secondLastDot + 1, lastDot);
    if (!platformValues.includes(possiblePlatform)) continue;

    overrides.push({ path: file.path, content: file.content, encoding: 'utf8' });
  }

  return overrides;
}

/**
 * Find where to install a new file based on adjacent file locations in cwd
 * Returns the directory path where the file should be installed, or null if no adjacent files found
 */
export async function resolveInstallPathFromAdjacent(
  adjacentIds: string[],
  cwdIdMap: Map<string, CwdIdMapEntry[]>
): Promise<string | null> {
  // Look for any adjacent file that exists in cwd
  for (const adjacentId of adjacentIds) {
    const cwdEntries = cwdIdMap.get(adjacentId);
    if (cwdEntries && cwdEntries.length > 0) {
      // Found adjacent files - use the first one's directory
      return dirname(cwdEntries[0].fullPath);
    }
  }
  
  return null;
}

/**
 * Validate and clean invalid formula files in cwd
 * - Files with valid IDs matching formula but not in registry → delete file
 */
export async function cleanupInvalidFormulaFiles(
  cwd: string,
  platforms: Platform[],
  formulaName: string,
  registryIdMap: Map<string, RegistryFileInfo>
): Promise<{ cleaned: string[]; deleted: string[] }> {
  const cleaned: string[] = [];
  const deleted: string[] = [];
  
  // Build set of valid registry IDs
  const validRegistryIds = new Set<string>();
  for (const [, info] of registryIdMap) {
    if (info.id && isValidEntityId(info.id)) {
      validRegistryIds.add(info.id);
    }
  }

  // Helper to process a file for cleanup
  const processFileForCleanup = async (filePath: string): Promise<void> => {
    try {
      const content = await readTextFile(filePath);
      const frontmatter = parseMarkdownFrontmatter(content);

      if (frontmatter?.formula?.name && areFormulaNamesEquivalent(frontmatter.formula.name, formulaName)) {
        const id = frontmatter.formula.id;

        if (id && isValidEntityId(id) && !validRegistryIds.has(id)) {
          await remove(filePath);
          deleted.push(filePath);
          logger.debug(`Deleted orphaned file ${filePath} with ID ${id}`);
        }
      }
    } catch (error) {
      logger.warn(`Failed to process file ${filePath}: ${error}`);
    }
  };

  // 1) AI directory
  const aiDir = join(cwd, PLATFORM_DIRS.AI);
  if (await exists(aiDir)) {
    const aiFiles = await findFilesByExtension(aiDir);
    await Promise.all(aiFiles.map(f => processFileForCleanup(f.fullPath)));
  }

  // 2) All platform subdirectories
  for (const platform of platforms) {
    const platformDef = getPlatformDefinition(platform);

    for (const [, subdirDef] of Object.entries(platformDef.subdirs)) {
      const subdirPath = join(cwd, platformDef.rootDir, subdirDef.path);

      if (!(await exists(subdirPath))) {
        continue;
      }

      const patterns = subdirDef.readExts && subdirDef.readExts.length > 0 ? subdirDef.readExts : [FILE_PATTERNS.MD_FILES];
      const files = await findFilesByExtension(subdirPath, patterns);
      await Promise.all(files.map(f => processFileForCleanup(f.fullPath)));
    }
  }

return { cleaned, deleted };
}
/**
 * Extract file ID information from a file path
 */
export async function extractFileIdInfo(filePath: string): Promise<FileIdInfo> {
  try {
    const content = await readTextFile(filePath);
    const frontmatter = parseMarkdownFrontmatter(content);
    
    const id = frontmatter?.formula?.id || null;
    const formulaName = frontmatter?.formula?.name || null;
    const isValid = id ? isValidEntityId(id) : false;
    
    return {
      fullPath: filePath,
      id,
      formulaName,
      isValid,
      frontmatter
    };
  } catch (error) {
    logger.warn(`Failed to extract ID info from ${filePath}: ${error}`);
    return {
      fullPath: filePath,
      id: null,
      formulaName: null,
      isValid: false,
      frontmatter: null
    };
  }
}

