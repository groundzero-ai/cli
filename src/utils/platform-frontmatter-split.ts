/**
 * Platform Frontmatter Split Utilities
 * Handles splitting platform-specific files into universal + platform-specific pieces
 */

import { basename } from 'path';
import { writeTextFile, readTextFile } from './fs.js';
import { FILE_PATTERNS, PLATFORM_DIRS, PLATFORMS } from '../constants/index.js';
import type { DiscoveredFile, PackageYml, PackageFile } from '../types/index.js';

/**
 * Split a platform-specific file's frontmatter if eligible.
 * Returns array of PackageFiles (universal md + optional platform yml) or null if not applicable.
 *
 * NOTE: Frontmatter support has been removed, so this always returns null.
 */
export async function splitPlatformFileFrontmatter(
  mdFile: DiscoveredFile,
  formulaConfig: PackageYml,
  rootFilenamesSet: Set<string>,
  logPrefix: string
): Promise<PackageFile[] | null> {
  // Frontmatter support removed - no splitting needed
  return null;
}
