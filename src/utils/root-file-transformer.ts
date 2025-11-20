/**
 * Root File Transformer Utility
 * Handles transformation of root file content for package operations
 */

import { extractPackageSection, buildOpenMarker, CLOSE_MARKER } from './root-file-extractor.js';

/**
 * Transform root file content for package renaming
 * Updates package name in markers
 *
 * @param content - The root file content
 * @param oldPackageName - The original package name in the marker
 * @param newPackageName - The new package name to use in the marker
 * @returns Updated content with new package name
 */
export function transformRootFileContent(
  content: string,
  oldPackageName: string,
  newPackageName: string
): string {
  // Extract the current package section
  const extracted = extractPackageSection(content, oldPackageName);
  if (!extracted) {
    // No valid marker found for the old package name, return unchanged
    return content;
  }

  // Build new marker with updated name
  const newMarker = buildOpenMarker(newPackageName);

  // Reconstruct the content with updated marker
  return newMarker + '\n' + extracted.sectionBody + '\n' + CLOSE_MARKER;
}
