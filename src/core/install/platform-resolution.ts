import { resolvePlatformName, type Platform } from '../platforms.js';
import { normalizePlatforms } from '../../utils/platform-mapper.js';
import { detectPlatforms, promptForPlatformSelection } from '../../utils/package-installation.js';

/**
 * Resolve platforms for an operation.
 * - Uses specified platforms if provided (validated against known platforms)
 * - Otherwise auto-detects
 * - If none detected and interactive=true, prompts user to select
 */
export async function resolvePlatforms(
  cwd: string,
  specified: string[] | undefined,
  options: { interactive?: boolean } = {}
): Promise<Platform[]> {
  const interactive = options.interactive === true;

  const normalized = normalizePlatforms(specified);
  if (normalized && normalized.length > 0) {
    const resolved = normalized.map(name => resolvePlatformName(name));
    const invalidIndex = resolved.findIndex(platform => !platform);
    if (invalidIndex !== -1) {
      throw new Error(`platform ${normalized[invalidIndex]} not found`);
    }
    return resolved as Platform[];
  }

  const auto = await detectPlatforms(cwd);
  if (auto.length > 0) return auto;

  if (interactive) {
    const selected = await promptForPlatformSelection();
    return selected;
  }

  return [] as Platform[];
}


