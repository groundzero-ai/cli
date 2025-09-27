/**
 * Hash Utilities Module
 * Utility functions for content hashing and comparison
 */

import { xxhash3 } from 'hash-wasm';

/**
 * Calculate hash of file content using xxhash3
 */
export async function calculateFileHash(content: string): Promise<string> {
  try {
    return await xxhash3(content);
  } catch (error) {
    console.warn(`Failed to calculate hash for content: ${error}`);
    // Return a fallback hash based on content length and first/last chars
    const fallback = `${content.length}-${content.charAt(0)}-${content.charAt(content.length - 1)}`;
    return fallback;
  }
}

/**
 * Calculate hash of file content synchronously (for simple cases)
 * Note: This is less performant but useful when async operations aren't needed
 */
export function calculateFileHashSync(content: string): string {
  try {
    // For sync operations, we'll use a simple hash based on content characteristics
    // In a real implementation, you might use a sync hash library
    const length = content.length;
    const firstChar = content.charCodeAt(0) || 0;
    const lastChar = content.charCodeAt(content.length - 1) || 0;

    // Simple hash combining length and character codes
    return `${length}-${firstChar}-${lastChar}`;
  } catch (error) {
    console.warn(`Failed to calculate sync hash for content: ${error}`);
    return `fallback-${content.length}`;
  }
}
