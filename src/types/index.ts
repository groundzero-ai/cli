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
  defaultAuthor?: string;
  defaultLicense?: string;
  profiles?: Record<string, ProfileConfig>;
}

export interface ProfileConfig {
  description?: string;
}

export interface ProfileCredentials {
  api_key: string;
}

export interface Profile {
  name: string;
  config: ProfileConfig;
  credentials?: ProfileCredentials;
}

export interface AuthOptions {
  profile?: string;
  apiKey?: string;
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
  metadata: FormulaYml;
  files: FormulaFile[];
}

// Formula.yml file types
export interface FormulaDependency {
  name: string;
  version: string;
}

export interface FormulaYml {
  name: string;
  version: string;
  description?: string;
  keywords?: string[];
  platforms?: string[];
  private?: boolean;
  formulas?: FormulaDependency[];
  'dev-formulas'?: FormulaDependency[];
  // Optional fields for version management
  created?: string;        // ISO timestamp
  updated?: string;        // ISO timestamp
  changelog?: string;      // Version-specific changelog
  deprecated?: boolean;    // Mark version as deprecated
  migration?: string;      // Migration notes for major version changes
}

// Command option types

export interface ListOptions {
  format: 'table' | 'json';
  filter?: string;
  all?: boolean;
  formulaName?: string;
}

export interface DeleteOptions {
  force?: boolean;
  interactive?: boolean;   // Interactive version selection
}

export interface PruneOptions {
  all?: boolean;           // Delete ALL prerelease versions (no preservation)
  dryRun?: boolean;        // Show what would be deleted
  force?: boolean;         // Skip all confirmations
  interactive?: boolean;   // Interactive selection mode
}

export interface PrereleaseVersion {
  formulaName: string;
  version: string;
  baseVersion: string;
  timestamp: number;       // Extracted from base62 encoding
  path: string;
}

export interface PruneResult {
  totalFound: number;
  totalDeleted: number;
  totalPreserved: number;
  deletedVersions: PrereleaseVersion[];
  preservedVersions: PrereleaseVersion[];
  freedSpace: number;      // In bytes
  errors: string[];
}

export interface InstallOptions {
  dryRun?: boolean;
  force?: boolean;
  variables?: Record<string, any>;
  dev?: boolean;
}

export interface UninstallOptions {
  dryRun?: boolean;
  keepData?: boolean;
  recursive?: boolean;
}

export interface PushOptions {
  version?: string;
  profile?: string;
  apiKey?: string;
}

export interface PullOptions {
  version?: string;
  profile?: string;
  apiKey?: string;
}

export interface SearchOptions {
  limit: string;
  registry?: string;
}

export interface SaveOptions {
  force?: boolean;
  version?: string;        // Specify version explicitly
  setLatest?: boolean;     // Mark this version as latest (for display purposes)
  bump?: 'patch' | 'minor' | 'major';  // Auto-bump version type
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
