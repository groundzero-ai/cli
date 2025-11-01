import { PullFormulaResponse } from '../types/api.js';
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


