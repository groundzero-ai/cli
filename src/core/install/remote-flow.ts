import type { RemotePackageMetadataSuccess, RemoteBatchPullResult } from '../remote-pull.js';
import type { ResolvedPackage } from '../dependency-resolver.js';
import { fetchRemotePackageMetadata, pullDownloadsBatchFromRemote, aggregateRecursiveDownloads, parseDownloadName } from '../remote-pull.js';
import { hasPackageVersion } from '../directory.js';
import { getVersionInfoFromDependencyTree } from '../../utils/install-helpers.js';
import { promptOverwriteConfirmation } from '../../utils/prompts.js';
import { Spinner } from '../../utils/spinner.js';
import { logger } from '../../utils/logger.js';
import { createDownloadKey } from './download-keys.js';
import { describeRemoteFailure } from './remote-reporting.js';

/**
 * Fetch metadata for missing dependencies
 */
export async function fetchMissingDependencyMetadata(
  missing: string[],
  resolvedPackages: ResolvedPackage[],
  opts: { dryRun: boolean; profile?: string; apiKey?: string }
): Promise<RemotePackageMetadataSuccess[]> {
  const { dryRun } = opts;
  const uniqueMissing = Array.from(new Set(missing));
  const metadataResults: RemotePackageMetadataSuccess[] = [];

  const metadataSpinner = dryRun ? null : new Spinner(`Fetching metadata for ${uniqueMissing.length} missing formula(s)...`);
  if (metadataSpinner) metadataSpinner.start();

  try {
    for (const missingName of uniqueMissing) {
      let requiredVersion: string | undefined;
      try {
        const versionInfo = await getVersionInfoFromDependencyTree(missingName, resolvedPackages);
        requiredVersion = versionInfo.requiredVersion;
      } catch (error) {
        logger.debug('Failed to determine required version for missing dependency', { missingName, error });
      }

      const metadataResult = await fetchRemotePackageMetadata(missingName, requiredVersion, { recursive: true, profile: opts.profile, apiKey: opts.apiKey });
      if (!metadataResult.success) {
        const message = describeRemoteFailure(requiredVersion ? `${missingName}@${requiredVersion}` : missingName, metadataResult);
        console.log(`⚠️  ${message}`);
        continue;
      }

      metadataResults.push(metadataResult);
    }
  } finally {
    if (metadataSpinner) metadataSpinner.stop();
  }

  return metadataResults;
}

/**
 * Pull missing dependencies from remote
 */
export async function pullMissingDependencies(
  metadata: RemotePackageMetadataSuccess[],
  keysToDownload: Set<string>,
  opts: { dryRun: boolean; profile?: string; apiKey?: string }
): Promise<RemoteBatchPullResult[]> {
  const { dryRun } = opts;
  const batchResults: RemoteBatchPullResult[] = [];
  const warnings: string[] = [];

  if (keysToDownload.size > 0 || dryRun) {
    const spinner = dryRun ? null : new Spinner(`Pulling ${keysToDownload.size} missing dependency formula(s) from remote...`);
    if (spinner) spinner.start();

    try {
      const remainingKeys = new Set(keysToDownload);

      for (const metadataResult of metadata) {
        if (!dryRun && remainingKeys.size === 0) {
          break;
        }

        const batchResult = await pullDownloadsBatchFromRemote(metadataResult.response, {
          httpClient: metadataResult.context.httpClient,
          profile: opts.profile || metadataResult.context.profile,
          apiKey: opts.apiKey,
          dryRun,
          filter: (dependencyName, dependencyVersion) => {
            const key = createDownloadKey(dependencyName, dependencyVersion);
            if (!keysToDownload.has(key)) {
              return false;
            }

            if (dryRun) {
              return true;
            }

            if (!remainingKeys.has(key)) {
              return false;
            }

            remainingKeys.delete(key);
            return true;
          }
        });

        batchResults.push(batchResult);
      }
    } finally {
      if (spinner) spinner.stop();
    }
  }

  return batchResults;
}

/**
 * Plan which downloads to pull for a formula based on remote metadata
 */
export async function planRemoteDownloadsForPackage(
  metadata: RemotePackageMetadataSuccess,
  opts: { forceRemote: boolean; dryRun: boolean }
): Promise<{ downloadKeys: Set<string>; warnings: string[] }> {
  const { forceRemote, dryRun } = opts;
  const aggregatedDownloads = aggregateRecursiveDownloads([metadata.response]);
  const downloadKeys = new Set<string>();
  const warnings: string[] = [];

  for (const download of aggregatedDownloads) {
    try {
      const { name: downloadName, version: downloadVersion } = parseDownloadName(download.name);
      const key = createDownloadKey(downloadName, downloadVersion);
      const existsLocally = await hasPackageVersion(downloadName, downloadVersion);

      if (forceRemote) {
        let shouldDownload = true;
        if (existsLocally) {
          if (dryRun) {
            console.log(`↪ Would prompt to overwrite ${key}`);
          } else {
            console.log(`⚠️  ${key} already exists locally`);
            const shouldOverwrite = await promptOverwriteConfirmation(downloadName, downloadVersion);
            if (!shouldOverwrite) {
              const skipMessage = `Skipped overwrite for ${key}`;
              warnings.push(skipMessage);
              shouldDownload = false;
            }
          }
        }

        if (shouldDownload) {
          downloadKeys.add(key);
        }
      } else if (!existsLocally) {
        downloadKeys.add(key);
      }
    } catch (error) {
      logger.debug('Skipping download due to invalid identifier', { download: download.name, error });
    }
  }

  return { downloadKeys, warnings };
}
