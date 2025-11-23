/**
 * API response types for the Package Registry
 */

export interface ApiPackage {
  name: string;
  description: string;
  keywords: string[];
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
  versions?: Array<ApiPackageVersion | string>;
}

export interface ApiPackageVersion {
  version: string;
  tarballSize: number;
  createdAt: string;
  updatedAt: string;
}

export interface PushPackageResponse {
  message: string;
  package: ApiPackage;
  version: ApiPackageVersion;
}

export interface PullPackageDownload {
  name: string;
  downloadUrl?: string;
}

export interface PullPackageResponse {
  package: ApiPackage;
  version: ApiPackageVersion;
  downloads: PullPackageDownload[];
  versions?: Array<ApiPackageVersion | string>;
  availableVersions?: string[];
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
  details?: any;
}

