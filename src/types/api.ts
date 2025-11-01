/**
 * API response types for the Formula Registry
 */

export interface ApiFormula {
  name: string;
  description: string;
  keywords: string[];
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApiFormulaVersion {
  version: string;
  tarballSize: number;
  createdAt: string;
  updatedAt: string;
}

export interface PushFormulaResponse {
  message: string;
  formula: ApiFormula;
  version: ApiFormulaVersion;
}

export interface PullFormulaDownload {
  name: string;
  downloadUrl?: string;
}

export interface PullFormulaResponse {
  formula: ApiFormula;
  version: ApiFormulaVersion;
  downloads: PullFormulaDownload[];
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
  details?: any;
}

