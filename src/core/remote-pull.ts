import * as yaml from 'js-yaml';
import { PullPackageDownload, PullPackageResponse } from '../types/api.js';
import { Package, PackageYml } from '../types/index.js';
import { packageManager } from './package.js';
import { ensureRegistryDirectories } from './directory.js';
import { authManager } from './auth.js';
import { createHttpClient, HttpClient } from '../utils/http-client.js';
import { extractPackageFromTarball, verifyTarballIntegrity, ExtractedPackage } from '../utils/tarball.js';
import { logger } from '../utils/logger.js';
import { ConfigError, ValidationError } from '../utils/errors.js';

const NETWORK_ERROR_PATTERN = /(fetch failed|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|network)/i;

function matchesNetworkPattern(value: unknown): boolean {
  return typeof value === 'string' && NETWORK_ERROR_PATTERN.test(value);
}

function isNetworkFailure(error: Error): boolean {
  if (matchesNetworkPattern(error.message)) {
    return true;
  }

  const cause = (error as any).cause;
  if (cause && (matchesNetworkPattern(cause.message) || matchesNetworkPattern(cause.code) || matchesNetworkPattern(cause.errno))) {
    return true;
  }

  if (matchesNetworkPattern((error as any).code) || matchesNetworkPattern((error as any).errno)) {
    return true;
  }

  return false;
}

export interface RemotePullContext {
  httpClient: HttpClient;
  profile: string;
  registryUrl: string;
}

export interface RemotePullOptions {
  profile?: string;
  apiKey?: string;
  quiet?: boolean;
  preFetchedResponse?: PullPackageResponse;
  httpClient?: HttpClient;
  recursive?: boolean;
}

export interface RemoteBatchPullOptions extends RemotePullOptions {
  dryRun?: boolean;
  filter?: (name: string, version: string, download: PullPackageDownload) => boolean;
}

export type RemotePullFailureReason =
  | 'not-found'
  | 'access-denied'
  | 'network'
  | 'integrity'
  | 'unknown';

export interface RemotePullFailure {
  success: false;
  reason: RemotePullFailureReason;
  message: string;
  statusCode?: number;
  error?: unknown;
}

export interface RemotePullSuccess {
  success: true;
  name: string;
  version: string;
  response: PullPackageResponse;
  extracted: ExtractedPackage;
  registryUrl: string;
  profile: string;
  downloadUrl: string;
  tarballSize: number;
}

export type RemotePullResult = RemotePullSuccess | RemotePullFailure;

export interface RemotePackageMetadataSuccess {
  success: true;
  context: RemotePullContext;
  response: PullPackageResponse;
}

export type RemotePackageMetadataResult = RemotePackageMetadataSuccess | RemotePullFailure;

export interface BatchDownloadItemResult {
  name: string;
  version: string;
  downloadUrl?: string;
  success: boolean;
  error?: string;
}

export interface RemoteBatchPullResult {
  success: boolean;
  pulled: BatchDownloadItemResult[];
  failed: BatchDownloadItemResult[];
  warnings?: string[];
}

export function parseDownloadName(downloadName: string): { name: string; version: string } {
  const atIndex = downloadName.lastIndexOf('@');

  if (atIndex <= 0 || atIndex === downloadName.length - 1) {
    throw new Error(`Invalid download name '${downloadName}'. Expected format '<package>@<version>'.`);
  }

  return {
    name: downloadName.slice(0, atIndex),
    version: downloadName.slice(atIndex + 1)
  };
}

export function aggregateRecursiveDownloads(responses: PullPackageResponse[]): PullPackageDownload[] {
  const aggregated = new Map<string, PullPackageDownload>();

  for (const response of responses) {
    if (!Array.isArray(response.downloads)) {
      continue;
    }

    for (const download of response.downloads) {
      if (!download?.name) {
        continue;
      }

      const existing = aggregated.get(download.name);

      if (!existing) {
        aggregated.set(download.name, download);
        continue;
      }

      if (!existing.downloadUrl && download.downloadUrl) {
        aggregated.set(download.name, download);
      }
    }
  }

  return Array.from(aggregated.values());
}

export async function pullDownloadsBatchFromRemote(
  responses: PullPackageResponse | PullPackageResponse[],
  options: RemoteBatchPullOptions = {}
): Promise<RemoteBatchPullResult> {
  const responseArray = Array.isArray(responses) ? responses : [responses];

  if (responseArray.length === 0) {
    return { success: true, pulled: [], failed: [] };
  }

  await ensureRegistryDirectories();

  const context = await createContext(options);
  const httpClient = context.httpClient;

  const downloads = aggregateRecursiveDownloads(responseArray);
  const pulled: BatchDownloadItemResult[] = [];
  const failed: BatchDownloadItemResult[] = [];
  const warnings: string[] = [];

  const tasks = downloads.map(async (download) => {
    const identifier = download.name;

    let parsedName: { name: string; version: string };

    try {
      parsedName = parseDownloadName(identifier);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Skipping download '${identifier}': ${message}`);
      failed.push({ name: identifier, version: '', downloadUrl: download.downloadUrl, success: false, error: message });
      return;
    }

    const { name, version } = parsedName;

    try {
      if (options.filter && !options.filter(name, version, download)) {
        return;
      }

      if (!download.downloadUrl) {
        const warning = `Download URL missing for ${identifier}`;
        logger.warn(warning);
        warnings.push(warning);
        failed.push({ name, version, downloadUrl: download.downloadUrl, success: false, error: 'download-url-missing' });
        return;
      }

      if (options.dryRun) {
        pulled.push({ name, version, downloadUrl: download.downloadUrl, success: true });
        return;
      }

      const tarballBuffer = await downloadPackageTarball(httpClient, download.downloadUrl);
      const extracted = await extractPackageFromTarball(tarballBuffer);
      const metadata = buildPackageMetadata(extracted, name, version);

      await packageManager.savePackage({ metadata, files: extracted.files });

      pulled.push({ name, version, downloadUrl: download.downloadUrl, success: true });
    } catch (error) {
      logger.debug('Batch download failed', { identifier, error });
      failed.push({
        name,
        version,
        downloadUrl: download.downloadUrl,
        success: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  });

  await Promise.all(tasks);

  return {
    success: failed.length === 0,
    pulled,
    failed,
    warnings: warnings.length > 0 ? warnings : undefined
  };
}

function buildPackageMetadata(
  extracted: ExtractedPackage,
  fallbackName: string,
  fallbackVersion: string
): PackageYml {
  const packageFile = extracted.files.find(file => file.path === 'package.yml');

  if (packageFile) {
    try {
      const parsed = yaml.load(packageFile.content) as PackageYml | undefined;

      if (parsed && typeof parsed === 'object' && parsed.name && parsed.version) {
        return parsed;
      }

      logger.debug('Parsed package.yml missing required fields, falling back to inferred metadata', {
        fallbackName,
        fallbackVersion
      });
    } catch (error) {
      logger.debug('Failed to parse package.yml from extracted tarball', {
        fallbackName,
        fallbackVersion,
        error
      });
    }
  }

  return {
    name: fallbackName,
    version: fallbackVersion,
  } as PackageYml;
}

export async function fetchRemotePackageMetadata(
  name: string,
  version: string | undefined,
  options: RemotePullOptions = {}
): Promise<RemotePackageMetadataResult> {
  try {
    await ensureRegistryDirectories();

    const context = await createContext(options);
    const response = await getRemotePackage(context.httpClient, name, version, options.recursive);

    return {
      success: true,
      context,
      response
    };
  } catch (error) {
    return mapErrorToFailure(error);
  }
}

export async function pullPackageFromRemote(
  name: string,
  version?: string,
  options: RemotePullOptions = {}
): Promise<RemotePullResult> {
  try {
    const metadataResult = options.preFetchedResponse
      ? await createResultFromPrefetched(options)
      : await fetchRemotePackageMetadata(name, version, options);

    if (!metadataResult.success) {
      return metadataResult;
    }

    const { context, response } = metadataResult;
    const downloadUrl = resolveDownloadUrl(response);
    if (!downloadUrl) {
      return {
        success: false,
        reason: 'access-denied',
        message: 'Package download not available for this account',
      };
    }

    const tarballBuffer = await downloadPackageTarball(context.httpClient, downloadUrl);

    if (!verifyTarballIntegrity(tarballBuffer, response.version.tarballSize)) {
      return {
        success: false,
        reason: 'integrity',
        message: 'Tarball integrity verification failed'
      };
    }

    const extracted = await extractPackageFromTarball(tarballBuffer);

    await savePackageToLocalRegistry(response, extracted);

    return {
      success: true,
      name: response.package.name,
      version: response.version.version,
      response,
      extracted,
      registryUrl: context.registryUrl,
      profile: context.profile,
      downloadUrl,
      tarballSize: response.version.tarballSize
    };
  } catch (error) {
    return mapErrorToFailure(error);
  }
}

function resolveDownloadUrl(response: PullPackageResponse): string | undefined {
  if (!Array.isArray(response.downloads) || response.downloads.length === 0) {
    return undefined;
  }

  const primaryMatch = response.downloads.find(download => download.name === response.package.name && download.downloadUrl);
  if (primaryMatch?.downloadUrl) {
    return primaryMatch.downloadUrl;
  }

  const fallbackMatch = response.downloads.find(download => download.downloadUrl);
  return fallbackMatch?.downloadUrl;
}

async function createResultFromPrefetched(options: RemotePullOptions): Promise<RemotePackageMetadataResult> {
  if (!options.preFetchedResponse) {
    throw new Error('preFetchedResponse missing from options');
  }

  const context = await createContext(options);

  return {
    success: true,
    context,
    response: options.preFetchedResponse
  };
}

async function createContext(options: RemotePullOptions): Promise<RemotePullContext> {
  const authOptions = {
    profile: options.profile,
    apiKey: options.apiKey
  };

  const httpClient = options.httpClient || await createHttpClient(authOptions);
  const profile = authManager.getCurrentProfile(authOptions);
  const registryUrl = authManager.getRegistryUrl();

  return {
    httpClient,
    profile,
    registryUrl
  };
}

async function getRemotePackage(
  httpClient: HttpClient,
  name: string,
  version?: string,
  recursive?: boolean,
): Promise<PullPackageResponse> {
  const encodedName = encodeURIComponent(name);
  let endpoint = version && version !== 'latest'
    ? `/packages/pull/by-name/${encodedName}/v/${encodeURIComponent(version)}`
    : `/packages/pull/by-name/${encodedName}`;
  const finalEndpoint = recursive
    ? `${endpoint}${endpoint.includes('?') ? '&' : '?'}recursive=true`
    : endpoint;
  logger.debug(`Fetching remote package metadata`, { name, version: version ?? 'latest', endpoint: finalEndpoint, recursive: !!recursive });
  return await httpClient.get<PullPackageResponse>(finalEndpoint);
}

async function downloadPackageTarball(httpClient: HttpClient, downloadUrl: string): Promise<Buffer> {
  const buffer = await httpClient.downloadFile(downloadUrl);
  return Buffer.from(buffer);
}

async function savePackageToLocalRegistry(
  response: PullPackageResponse,
  extracted: ExtractedPackage
): Promise<void> {
  const metadata: PackageYml & Record<string, unknown> = {
    name: response.package.name,
    version: response.version.version,
    description: response.package.description,
    keywords: response.package.keywords,
    private: response.package.isPrivate
  };

  (metadata as any).files = extracted.files.map(file => file.path);
  (metadata as any).created = response.version.createdAt;
  (metadata as any).updated = response.version.updatedAt;

  const pkg: Package = {
    metadata: metadata as PackageYml,
    files: extracted.files
  };

  await packageManager.savePackage(pkg);
}

function mapErrorToFailure(error: unknown): RemotePullFailure {
  logger.debug('Remote pull operation failed', { error });

  if (error instanceof ValidationError) {
    return {
      success: false,
      reason: 'integrity',
      message: error.message,
      error
    };
  }

  if (error instanceof ConfigError) {
    return {
      success: false,
      reason: 'access-denied',
      message: error.message,
      error
    };
  }

  if (error instanceof Error) {
    const apiError = (error as any).apiError;

    if (apiError?.statusCode === 404) {
      const failure: RemotePullFailure = {
        success: false,
        reason: 'not-found',
        message: error.message,
        statusCode: 404,
        error
      };
      return failure;
    }

    if (apiError?.statusCode === 401 || apiError?.statusCode === 403) {
      return {
        success: false,
        reason: 'access-denied',
        message: error.message,
        statusCode: apiError.statusCode,
        error
      };
    }

    if (isNetworkFailure(error)) {
      return {
        success: false,
        reason: 'network',
        message: error.message,
        error
      };
    }

    return {
      success: false,
      reason: 'unknown',
      message: error.message,
      error
    };
  }

  return {
    success: false,
    reason: 'unknown',
    message: 'Unknown error occurred',
    error
  };
}


