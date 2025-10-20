import { PLATFORMS, type Platform } from '../../constants/index.js';
import { normalizePlatforms } from '../../utils/platform-mapper.js';
import { detectPlatforms, promptForPlatformSelection } from '../../utils/formula-installation.js';

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
    const known = new Set<string>(Object.values(PLATFORMS));
    const invalid = normalized.filter(p => !known.has(p));
    if (invalid.length > 0) {
      throw new Error(`platform ${invalid[0]} not found`);
    }
    return normalized as Platform[];
  }

  const auto = await detectPlatforms(cwd);
  if (auto.length > 0) return auto as Platform[];

  if (interactive) {
    const selected = await promptForPlatformSelection();
    return selected as Platform[];
  }

  return [] as Platform[];
}


