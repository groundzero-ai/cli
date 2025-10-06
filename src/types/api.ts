/**
 * API response types for the Formula Registry
 */

export interface ApiFormula {
  _id: string;
  name: string;
  description: string;
  keywords: string[];
  isPrivate: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApiFormulaVersion {
  _id: string;
  formulaId: string;
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

