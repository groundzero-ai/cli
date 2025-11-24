import * as semver from 'semver';
import { listPackageVersions } from '../directory.js';
import {
  fetchRemotePackageMetadata,
  type RemotePackageMetadataResult,
  type RemotePullFailure
} from '../remote-pull.js';
import type { PullPackageResponse } from '../../types/api.js';
import { describeRemoteFailure } from './remote-reporting.js';
import { InstallResolutionMode } from './types.js';
import {
  selectVersionWithWipPolicy,
  type VersionSelectionOptions,
  type VersionSelectionResult
} from '../../utils/version-ranges.js';

export interface VersionSourceSummary {
  localVersions: string[];
  remoteVersions: string[];
  availableVersions: string[];
  remoteStatus: 'skipped' | 'success' | 'failed';
  warnings: string[];
  remoteError?: string;
  fallbackToLocalOnly?: boolean;
}

export interface GatherVersionSourcesArgs {
  packageName: string;
  mode: InstallResolutionMode;
  localVersions?: string[];
  remoteVersions?: string[];
  profile?: string;
  apiKey?: string;
}

export interface InstallVersionSelectionArgs extends GatherVersionSourcesArgs {
  constraint: string;
  explicitPrereleaseIntent?: boolean;
  selectionOptions?: VersionSelectionOptions;
}

export interface InstallVersionSelectionResult {
  selectedVersion: string | null;
  selection: VersionSelectionResult;
  sources: VersionSourceSummary;
  constraint: string;
  mode: InstallResolutionMode;
}

export class RemoteResolutionRequiredError extends Error {
  constructor(message: string, public details?: { packageName: string }) {
    super(message);
    this.name = 'RemoteResolutionRequiredError';
  }
}

interface RemoteVersionLookupOptions {
  profile?: string;
  apiKey?: string;
}

interface RemoteVersionLookupSuccess {
  success: true;
  versions: string[];
}

interface RemoteVersionLookupFailure {
  success: false;
  failure: RemotePullFailure;
}

type RemoteVersionLookupResult = RemoteVersionLookupSuccess | RemoteVersionLookupFailure;

export async function gatherVersionSourcesForInstall(args: GatherVersionSourcesArgs): Promise<VersionSourceSummary> {
  const normalizedLocal = normalizeAndSortVersions(
    args.localVersions ?? await listPackageVersions(args.packageName)
  );
  let remoteVersions: string[] = [];
  let remoteStatus: VersionSourceSummary['remoteStatus'] = 'skipped';
  let remoteError: string | undefined;
  const warnings: string[] = [];

  if (args.mode !== 'local-only') {
    if (args.remoteVersions) {
      remoteVersions = normalizeAndSortVersions(args.remoteVersions);
      remoteStatus = 'success';
    } else {
      const remoteLookup = await fetchRemoteVersions(args.packageName, {
        profile: args.profile,
        apiKey: args.apiKey
      });

      if (remoteLookup.success) {
        remoteVersions = normalizeAndSortVersions(remoteLookup.versions);
        remoteStatus = 'success';
      } else {
        remoteStatus = 'failed';
        remoteError = describeRemoteFailure(args.packageName, remoteLookup.failure);
      }
    }
  }

  if (args.mode === 'local-only') {
    return {
      localVersions: normalizedLocal,
      remoteVersions: [],
      availableVersions: normalizedLocal,
      remoteStatus: 'skipped',
      warnings
    };
  }

  if (args.mode === 'remote-primary') {
    if (remoteStatus !== 'success') {
      throw new RemoteResolutionRequiredError(
        remoteError ?? `Remote registry data required to resolve ${args.packageName}`,
        { packageName: args.packageName }
      );
    }

    return {
      localVersions: normalizedLocal,
      remoteVersions,
      availableVersions: remoteVersions,
      remoteStatus,
      warnings
    };
  }

  const fallbackToLocalOnly = remoteStatus !== 'success';

  if (fallbackToLocalOnly && remoteError) {
    warnings.push(`Using local version (error: ${remoteError})`);
  }

  return {
    localVersions: normalizedLocal,
    remoteVersions,
    availableVersions: fallbackToLocalOnly ? normalizedLocal : mergeAndSortVersions(normalizedLocal, remoteVersions),
    remoteStatus,
    warnings,
    remoteError,
    fallbackToLocalOnly
  };
}

export async function selectVersionForInstall(args: InstallVersionSelectionArgs): Promise<InstallVersionSelectionResult> {
  const sources = await gatherVersionSourcesForInstall(args);
  
  // Merge preferStable from selectionOptions if provided
  const selectionOptions: VersionSelectionOptions = {
    ...(args.selectionOptions ?? {}),
    ...(args.explicitPrereleaseIntent ? { explicitPrereleaseIntent: true } : {})
  };
  
  const selection = selectVersionWithWipPolicy(
    sources.availableVersions,
    args.constraint,
    selectionOptions
  );

  return {
    selectedVersion: selection.version,
    selection,
    sources,
    constraint: args.constraint,
    mode: args.mode
  };
}

async function fetchRemoteVersions(
  packageName: string,
  options: RemoteVersionLookupOptions
): Promise<RemoteVersionLookupResult> {
  const metadataResult = await fetchRemotePackageMetadata(packageName, undefined, {
    profile: options.profile,
    apiKey: options.apiKey,
    recursive: false
  });

  if (!metadataResult.success) {
    return { success: false, failure: metadataResult };
  }

  const versions = extractVersionsFromRemoteResponse(metadataResult.response);
  return { success: true, versions };
}

function extractVersionsFromRemoteResponse(response: PullPackageResponse): string[] {
  const collected = new Set<string>();

  const candidates: Array<unknown> = [];
  const packageAny = response.package as any;
  if (Array.isArray(packageAny?.versions)) {
    candidates.push(...packageAny.versions);
  }

  const responseAny = response as any;
  if (Array.isArray(responseAny?.versions)) {
    candidates.push(...responseAny.versions);
  }
  if (Array.isArray(responseAny?.availableVersions)) {
    candidates.push(...responseAny.availableVersions);
  }

  for (const candidate of candidates) {
    const normalized = extractVersionString(candidate);
    if (normalized) {
      collected.add(normalized);
    }
  }

  if (response.version?.version) {
    collected.add(response.version.version);
  }

  return Array.from(collected);
}

function extractVersionString(candidate: unknown): string | null {
  if (typeof candidate === 'string') {
    return semver.valid(candidate) ? candidate : null;
  }

  if (candidate && typeof candidate === 'object') {
    const value = (candidate as any).version;
    if (typeof value === 'string' && semver.valid(value)) {
      return value;
    }
  }

  return null;
}

function normalizeAndSortVersions(versions: string[]): string[] {
  const normalized = new Set<string>();
  for (const version of versions) {
    if (typeof version !== 'string') {
      continue;
    }
    const trimmed = version.trim();
    if (!trimmed || !semver.valid(trimmed)) {
      continue;
    }
    normalized.add(trimmed);
  }
  return Array.from(normalized).sort(semver.rcompare);
}

function mergeAndSortVersions(left: string[], right: string[]): string[] {
  const merged = new Set<string>([...left, ...right]);
  return Array.from(merged).sort(semver.rcompare);
}

