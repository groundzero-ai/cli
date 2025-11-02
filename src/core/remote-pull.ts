import * as yaml from 'js-yaml';
import { PullFormulaDownload, PullFormulaResponse } from '../types/api.js';
import { Formula, FormulaYml } from '../types/index.js';
import { formulaManager } from './formula.js';
import { ensureRegistryDirectories } from './directory.js';
import { authManager } from './auth.js';
import { createHttpClient, HttpClient } from '../utils/http-client.js';
import { extractFormulaFromTarball, verifyTarballIntegrity, ExtractedFormula } from '../utils/tarball.js';
import { logger } from '../utils/logger.js';
import { ConfigError, ValidationError } from '../utils/errors.js';

interface RemotePullContext {
  httpClient: HttpClient;
  profile: string;
  registryUrl: string;
}

export interface RemotePullOptions {
  profile?: string;
  apiKey?: string;
  quiet?: boolean;
  preFetchedResponse?: PullFormulaResponse;
  httpClient?: HttpClient;
  recursive?: boolean;
}

export interface RemoteBatchPullOptions extends RemotePullOptions {
  dryRun?: boolean;
  filter?: (name: string, version: string, download: PullFormulaDownload) => boolean;
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
  response: PullFormulaResponse;
  extracted: ExtractedFormula;
  registryUrl: string;
  profile: string;
  downloadUrl: string;
  tarballSize: number;
}

export type RemotePullResult = RemotePullSuccess | RemotePullFailure;

export interface RemoteFormulaMetadataSuccess {
  success: true;
  context: RemotePullContext;
  response: PullFormulaResponse;
}

export type RemoteFormulaMetadataResult = RemoteFormulaMetadataSuccess | RemotePullFailure;

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
    throw new Error(`Invalid download name '${downloadName}'. Expected format '<formula>@<version>'.`);
  }

  return {
    name: downloadName.slice(0, atIndex),
    version: downloadName.slice(atIndex + 1)
  };
}

export function aggregateRecursiveDownloads(responses: PullFormulaResponse[]): PullFormulaDownload[] {
  const aggregated = new Map<string, PullFormulaDownload>();

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
  responses: PullFormulaResponse | PullFormulaResponse[],
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

      const tarballBuffer = await downloadFormulaTarball(httpClient, download.downloadUrl);
      const extracted = await extractFormulaFromTarball(tarballBuffer);
      const metadata = buildFormulaMetadata(extracted, name, version);

      await formulaManager.saveFormula({ metadata, files: extracted.files });

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

function buildFormulaMetadata(
  extracted: ExtractedFormula,
  fallbackName: string,
  fallbackVersion: string
): FormulaYml {
  const formulaFile = extracted.files.find(file => file.path === 'formula.yml');

  if (formulaFile) {
    try {
      const parsed = yaml.load(formulaFile.content) as FormulaYml | undefined;

      if (parsed && typeof parsed === 'object' && parsed.name && parsed.version) {
        return parsed;
      }

      logger.debug('Parsed formula.yml missing required fields, falling back to inferred metadata', {
        fallbackName,
        fallbackVersion
      });
    } catch (error) {
      logger.debug('Failed to parse formula.yml from extracted tarball', {
        fallbackName,
        fallbackVersion,
        error
      });
    }
  }

  return {
    name: fallbackName,
    version: fallbackVersion,
  } as FormulaYml;
}

export async function fetchRemoteFormulaMetadata(
  name: string,
  version: string | undefined,
  options: RemotePullOptions = {}
): Promise<RemoteFormulaMetadataResult> {
  try {
    await ensureRegistryDirectories();

    const context = await createContext(options);
    const response = await getRemoteFormula(context.httpClient, name, version, options.recursive);

    return {
      success: true,
      context,
      response
    };
  } catch (error) {
    return mapErrorToFailure(error);
  }
}

export async function pullFormulaFromRemote(
  name: string,
  version?: string,
  options: RemotePullOptions = {}
): Promise<RemotePullResult> {
  try {
    const metadataResult = options.preFetchedResponse
      ? await createResultFromPrefetched(options)
      : await fetchRemoteFormulaMetadata(name, version, options);

    if (!metadataResult.success) {
      return metadataResult;
    }

    const { context, response } = metadataResult;
    const downloadUrl = resolveDownloadUrl(response);
    if (!downloadUrl) {
      return {
        success: false,
        reason: 'access-denied',
        message: 'Formula download not available for this account',
      };
    }

    const tarballBuffer = await downloadFormulaTarball(context.httpClient, downloadUrl);

    if (!verifyTarballIntegrity(tarballBuffer, response.version.tarballSize)) {
      return {
        success: false,
        reason: 'integrity',
        message: 'Tarball integrity verification failed'
      };
    }

    const extracted = await extractFormulaFromTarball(tarballBuffer);

    await saveFormulaToLocalRegistry(response, extracted);

    return {
      success: true,
      name: response.formula.name,
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

function resolveDownloadUrl(response: PullFormulaResponse): string | undefined {
  if (!Array.isArray(response.downloads) || response.downloads.length === 0) {
    return undefined;
  }

  const primaryMatch = response.downloads.find(download => download.name === response.formula.name && download.downloadUrl);
  if (primaryMatch?.downloadUrl) {
    return primaryMatch.downloadUrl;
  }

  const fallbackMatch = response.downloads.find(download => download.downloadUrl);
  return fallbackMatch?.downloadUrl;
}

async function createResultFromPrefetched(options: RemotePullOptions): Promise<RemoteFormulaMetadataResult> {
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

async function getRemoteFormula(
  httpClient: HttpClient,
  name: string,
  version?: string,
  recursive?: boolean,
): Promise<PullFormulaResponse> {
  const encodedName = name.split('/').map(segment => encodeURIComponent(segment)).join('/');
  let endpoint = version && version !== 'latest'
    ? `/formulas/pull/by-name/${encodedName}/v/${encodeURIComponent(version)}`
    : `/formulas/pull/by-name/${encodedName}`;
  const finalEndpoint = recursive
    ? `${endpoint}${endpoint.includes('?') ? '&' : '?'}recursive=true`
    : endpoint;
  logger.debug(`Fetching remote formula metadata`, { name, version: version ?? 'latest', endpoint: finalEndpoint, recursive: !!recursive });
  return await httpClient.get<PullFormulaResponse>(finalEndpoint);
}

async function downloadFormulaTarball(httpClient: HttpClient, downloadUrl: string): Promise<Buffer> {
  const buffer = await httpClient.downloadFile(downloadUrl);
  return Buffer.from(buffer);
}

async function saveFormulaToLocalRegistry(
  response: PullFormulaResponse,
  extracted: ExtractedFormula
): Promise<void> {
  const metadata: FormulaYml & Record<string, unknown> = {
    name: response.formula.name,
    version: response.version.version,
    description: response.formula.description,
    keywords: response.formula.keywords,
    private: response.formula.isPrivate
  };

  (metadata as any).files = extracted.files.map(file => file.path);
  (metadata as any).created = response.version.createdAt;
  (metadata as any).updated = response.version.updatedAt;

  const formula: Formula = {
    metadata: metadata as FormulaYml,
    files: extracted.files
  };

  await formulaManager.saveFormula(formula);
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
      return {
        success: false,
        reason: 'not-found',
        message: error.message,
        statusCode: 404,
        error
      };
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

    if (error.message.includes('Download') || error.message.includes('timeout')) {
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


