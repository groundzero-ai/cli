/**
 * Common types and interfaces for the G0 CLI application
 */

// Core application types
export interface G0Directories {
  config: string;
  data: string;
  cache: string;
  runtime: string;
}

export interface G0Config {
  registryUrl?: string;
  defaultAuthor?: string;
  defaultLicense?: string;
  cacheTimeout?: number;
}

// Formula types
export interface FormulaMetadata {
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  keywords?: string[];
  dependencies?: string[];
  created: string;
  updated: string;
  files: string[];
  excludePatterns?: string[];
  templateVariables?: TemplateVariable[];
}

export interface TemplateVariable {
  name: string;
  description?: string;
  type: 'string' | 'number' | 'boolean';
  required?: boolean;
  default?: string | number | boolean;
}

export interface FormulaFile {
  path: string;
  content: string;
  isTemplate: boolean;
  encoding?: string;
}

export interface Formula {
  metadata: FormulaMetadata;
  files: FormulaFile[];
}

// Command option types
export interface CreateOptions {
  description?: string;
  version: string;
  exclude?: string;
  author?: string;
  license?: string;
  keywords?: string;
}

export interface ListOptions {
  format: 'table' | 'json';
  filter?: string;
}

export interface DeleteOptions {
  force?: boolean;
}

export interface InstallOptions {
  dryRun?: boolean;
  set: string[];
  force?: boolean;
  variables?: Record<string, any>;
}

export interface UninstallOptions {
  dryRun?: boolean;
  keepData?: boolean;
}

export interface PushOptions {
  version?: string;
  registry?: string;
}

export interface PullOptions {
  version?: string;
  registry?: string;
}

export interface SearchOptions {
  limit: string;
  registry?: string;
}

// Registry types
export interface RegistryEntry {
  name: string;
  version: string;
  description?: string;
  author?: string;
  downloadCount?: number;
  lastUpdated: string;
}

export interface SearchResult {
  entries: RegistryEntry[];
  total: number;
  page: number;
  limit: number;
}

// Status and error types
export interface FormulaStatus {
  name: string;
  version: string;
  status: 'installed' | 'outdated' | 'modified' | 'error';
  installedAt?: string;
  availableVersion?: string;
}

export interface CommandResult<T = any> {
  success: boolean;
  data?: T;
  error?: string;
  warnings?: string[];
}

// Error types
export class G0Error extends Error {
  public code: string;
  public details?: any;

  constructor(message: string, code: string, details?: any) {
    super(message);
    this.name = 'G0Error';
    this.code = code;
    this.details = details;
  }
}

export enum ErrorCodes {
  FORMULA_NOT_FOUND = 'FORMULA_NOT_FOUND',
  FORMULA_ALREADY_EXISTS = 'FORMULA_ALREADY_EXISTS',
  INVALID_FORMULA = 'INVALID_FORMULA',
  REGISTRY_ERROR = 'REGISTRY_ERROR',
  NETWORK_ERROR = 'NETWORK_ERROR',
  FILE_SYSTEM_ERROR = 'FILE_SYSTEM_ERROR',
  PERMISSION_ERROR = 'PERMISSION_ERROR',
  VALIDATION_ERROR = 'VALIDATION_ERROR',
  CONFIG_ERROR = 'CONFIG_ERROR'
}

// Logger types
export enum LogLevel {
  DEBUG = 'debug',
  INFO = 'info',
  WARN = 'warn',
  ERROR = 'error'
}

export interface Logger {
  debug(message: string, meta?: any): void;
  info(message: string, meta?: any): void;
  warn(message: string, meta?: any): void;
  error(message: string, meta?: any): void;
}
