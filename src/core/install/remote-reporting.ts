import type { RemoteBatchPullResult, RemotePullFailure } from '../remote-pull.js';
import { createDownloadKey } from './download-keys.js';

/**
 * Record the outcome of a batch pull operation
 */
export function recordBatchOutcome(
  label: string,
  result: RemoteBatchPullResult,
  warnings: string[],
  dryRun: boolean
): void {
  if (result.warnings) {
    warnings.push(...result.warnings);
  }

  const successful = result.pulled.map(item => createDownloadKey(item.name, item.version));
  const failed = result.failed.map(item => ({
    key: createDownloadKey(item.name, item.version),
    error: item.error ?? 'Unknown error'
  }));

  if (dryRun) {
    if (successful.length > 0) {
      console.log(`↪ Would ${label}: ${successful.join(', ')}`);
    }

    if (failed.length > 0) {
      for (const failure of failed) {
        const message = `Dry run: would fail to ${label} ${failure.key}: ${failure.error}`;
        console.log(`⚠️  ${message}`);
        warnings.push(message);
      }
    }

    return;
  }

  if (successful.length > 0) {
    console.log(`✓ ${label}: ${successful.length}`);
      for (const key of successful) {
        console.log(`   ├── ${key}`);
      }
  }

  if (failed.length > 0) {
    for (const failure of failed) {
      const message = `Failed to ${label} ${failure.key}: ${failure.error}`;
      console.log(`⚠️  ${message}`);
      warnings.push(message);
    }
  }
}

/**
 * Describe a remote failure in a user-friendly way
 */
export function describeRemoteFailure(label: string, failure: RemotePullFailure): string {
  switch (failure.reason) {
    case 'not-found':
      return `Formula '${label}' not found in remote registry`;
    case 'access-denied':
      return failure.message || `Access denied pulling ${label}`;
    case 'network':
      return failure.message || `Network error pulling ${label}`;
    case 'integrity':
      return failure.message || `Integrity check failed pulling ${label}`;
    default:
      return failure.message || `Failed to pull ${label}`;
  }
}
