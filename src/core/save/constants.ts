
export const UTF8_ENCODING = 'utf8' as const;
export const DEFAULT_VERSION = '0.1.0';
export const VERSION_TYPE_STABLE = 'stable';

export const ERROR_MESSAGES = {
  INVALID_FORMULA_SYNTAX: 'Invalid formula syntax: %s. Use format: formula@version',
  VERSION_EXISTS: 'Version %s already exists. Use --force to overwrite.',
  SAVE_FAILED: 'Failed to save formula',
  OPERATION_CANCELLED: 'Operation cancelled by user',
  INVALID_VERSION_FORMAT: 'Invalid version format: %s',
  INVALID_BUMP_TYPE: 'Invalid bump type: %s. Must be \'patch\', \'minor\', or \'major\'.',
  INVALID_VERSION_TYPE: 'Invalid version type: %s. Only \'%s\' is supported.',
  PARSE_FORMULA_FAILED: 'Failed to parse existing formula.yml at %s: %s',
  FORMULA_DIR_NOT_FOUND: 'Formula directory not found at %s'
} as const;

export const LOG_PREFIXES = {
  CREATED: '✓ Created formula.yml in',
  FOUND: '✓ Found existing formula.yml',
  NAME: '✓ Name:',
  VERSION: '✓ Version:',
  FILES: '✓ Found',
  FILES_SUFFIX: 'markdown files',
  RESOLVED: '✓ Conflicts resolved, processed',
  SAVED: '✓ Saved',
  UPDATED: '✓ Updated frontmatter in',
  EXPLICIT_VERSION: '✓ Using explicit version:',
  PRERELEASE: '✓ New formula, setting to prerelease:',
  BUMP_STABLE: '✓ Bumping to stable version:',
  BUMP_PRERELEASE: '✓ Bumping to prerelease version:',
  CONVERT_STABLE: '✓ Converting to stable version:',
  OVERWRITE_STABLE: '✓ Overwriting stable version:',
  INCREMENT_PRERELEASE: '✓ Incrementing prerelease version:',
  AUTO_INCREMENT: '✓ Auto-incrementing to patch prerelease:',
  WARNING: '⚠️  Version',
  WARNING_SUFFIX: 'is already stable.',
  ARROW_SEPARATOR: ' → '
} as const;