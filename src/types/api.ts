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

export interface PullFormulaResponse {
  formula: ApiFormula;
  version: ApiFormulaVersion;
  downloadUrl: string;
}

export interface ApiError {
  error: string;
  message: string;
  statusCode: number;
  details?: any;
}

