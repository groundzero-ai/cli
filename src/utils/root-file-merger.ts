/**
 * Root File Content Merger Utility
 * Handles marker-based content merging for root files (AGENTS.md, CLAUDE.md, etc.)
 */

import { buildOpenMarker, buildOpenMarkerRegex, CLOSE_MARKER, CLOSE_MARKER_REGEX } from './root-file-extractor.js';

/**
 * Merge formula-specific content into a root file while preserving all other content.
 * Finds the formula section between markers and replaces it, or appends if not found.
 * 
 * @param existingContent - The current content of the root file (or empty string)
 * @param formulaName - Name of the formula to merge
 * @param newContent - Section body to insert between the markers (without markers)
 * @returns Updated root file content with formula section merged
 */
export function mergeFormulaContentIntoRootFile(
  existingContent: string,
  formulaName: string,
  newContent: string
): string {
  if (!formulaName) {
    throw new Error('Formula name is required for merging');
  }

  const openMarker = buildOpenMarker(formulaName);
  const closeMarker = CLOSE_MARKER;
  
  // Create regex to find existing formula section
  const openRe = buildOpenMarkerRegex(formulaName);
  const closeRe = CLOSE_MARKER_REGEX;

  const openMatch = openRe.exec(existingContent);
  
  if (!openMatch) {
    // Formula section doesn't exist - append it
    const separator = existingContent.trim() ? '\n\n' : '';
    return existingContent.trim() + separator + openMarker + '\n' + newContent.trim() + '\n' + closeMarker + '\n';
  }

  // Formula section exists - check if it already has the correct content
  const beforeSection = existingContent.substring(0, openMatch.index);
  const afterMarkerIndex = openMatch.index + openMatch[0].length;
  const restContent = existingContent.substring(afterMarkerIndex);

  const closeMatch = closeRe.exec(restContent);

  if (!closeMatch) {
    // Malformed - missing closing marker, append new section at end
    const separator = existingContent.trim() ? '\n\n' : '';
    return existingContent.trim() + separator + openMarker + '\n' + newContent.trim() + '\n' + closeMarker + '\n';
  }

  // Extract the existing section content
  const existingSectionBody = restContent.substring(0, closeMatch.index).trim();
  const afterCloseMarkerIndex = closeMatch.index + closeMatch[0].length;
  const afterSection = restContent.substring(afterCloseMarkerIndex);

  // Check if the existing section already has the correct content and marker
  // Use component-wise comparison to avoid issues with whitespace formatting differences
  const existingOpenMarker = openMatch[0];
  const hasCorrectMarker = existingOpenMarker === openMarker;
  const hasCorrectContent = existingSectionBody === newContent.trim();
  const hasCloseMarker = true; // We already verified closeMatch exists

  if (hasCorrectMarker && hasCorrectContent && hasCloseMarker) {
    // Existing section is already correct, return unchanged
    return existingContent;
  }

  // Replace the section content
  return beforeSection + openMarker + '\n' + newContent.trim() + '\n' + closeMarker + afterSection;
}

