import type { PullFormulaDownload } from '../../types/api.js';
import { hasFormulaVersion } from '../directory.js';
import { parseDownloadName } from '../remote-pull.js';
import { logger } from '../../utils/logger.js';

/**
 * Create a unique key for a download based on name and version
 */
export function createDownloadKey(name: string, version: string): string {
  return `${name}@${version}`;
}

/**
 * Compute which download keys are missing locally
 */
export async function computeMissingDownloadKeys(downloads: PullFormulaDownload[]): Promise<Set<string>> {
  const missingKeys = new Set<string>();

  for (const download of downloads) {
    if (!download?.name) {
      continue;
    }

    try {
      const { name, version } = parseDownloadName(download.name);
      if (!version) {
        continue;
      }

      const existsLocally = await hasFormulaVersion(name, version);
      if (!existsLocally) {
        missingKeys.add(createDownloadKey(name, version));
      }
    } catch (error) {
      logger.debug('Skipping download due to invalid name', { download: download.name, error });
    }
  }

  return missingKeys;
}
