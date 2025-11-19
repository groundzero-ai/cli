import { join } from 'path';
import { OpenPackageConfig, OpenPackageDirectories } from '../types/index.js';
import { readJsonFile, writeJsonFile, exists } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { ConfigError } from '../utils/errors.js';
import { getOpenPackageDirectories } from './directory.js';

/**
 * Configuration management for the OpenPackage CLI
 */

const CONFIG_FILE_NAME = 'config.json';

// Default configuration values
const DEFAULT_CONFIG: OpenPackageConfig = {
  defaultAuthor: undefined,
  defaultLicense: 'MIT'
};

class ConfigManager {
  private config: OpenPackageConfig | null = null;
  private configPath: string;
  private openPackageDirs: OpenPackageDirectories;

  constructor() {
    this.openPackageDirs = getOpenPackageDirectories();
    this.configPath = join(this.openPackageDirs.config, CONFIG_FILE_NAME);
  }

  /**
   * Load configuration from file, create default if it doesn't exist
   */
  async load(): Promise<OpenPackageConfig> {
    if (this.config) {
      return this.config;
    }

    try {
      if (await exists(this.configPath)) {
        logger.debug(`Loading config from: ${this.configPath}`);
        const fileConfig = await readJsonFile<OpenPackageConfig>(this.configPath);
        this.config = { ...DEFAULT_CONFIG, ...fileConfig };
      } else {
        logger.debug('Config file not found, using defaults');
        this.config = { ...DEFAULT_CONFIG };
        await this.save(); // Create the config file with defaults
      }

      return this.config;
    } catch (error) {
      logger.error('Failed to load configuration', { error, configPath: this.configPath });
      throw new ConfigError(`Failed to load configuration: ${error}`);
    }
  }

  /**
   * Save current configuration to file
   */
  async save(): Promise<void> {
    if (!this.config) {
      throw new ConfigError('No configuration loaded to save');
    }

    try {
      logger.debug(`Saving config to: ${this.configPath}`);
      await writeJsonFile(this.configPath, this.config);
    } catch (error) {
      logger.error('Failed to save configuration', { error, configPath: this.configPath });
      throw new ConfigError(`Failed to save configuration: ${error}`);
    }
  }

  /**
   * Get a configuration value
   */
  async get<K extends keyof OpenPackageConfig>(key: K): Promise<OpenPackageConfig[K]> {
    const config = await this.load();
    return config[key];
  }

  /**
   * Set a configuration value
   */
  async set<K extends keyof OpenPackageConfig>(key: K, value: OpenPackageConfig[K]): Promise<void> {
    const config = await this.load();
    config[key] = value;
    this.config = config;
    await this.save();
    logger.info(`Configuration updated: ${key} = ${value}`);
  }

  /**
   * Get all configuration values
   */
  async getAll(): Promise<OpenPackageConfig> {
    return await this.load();
  }

  /**
   * Reset configuration to defaults
   */
  async reset(): Promise<void> {
    this.config = { ...DEFAULT_CONFIG };
    await this.save();
    logger.info('Configuration reset to defaults');
  }

  /**
   * Validate configuration
   */
  async validate(): Promise<boolean> {
    try {
      const config = await this.load();
      
      // Basic validation - config structure is valid
      if (typeof config !== 'object' || config === null) {
        throw new ConfigError('Invalid configuration structure');
      }

      return true;
    } catch (error) {
      logger.error('Configuration validation failed', { error });
      return false;
    }
  }

  /**
   * Get the configuration file path
   */
  getConfigPath(): string {
    return this.configPath;
  }

  /**
   * Get OpenPackage directories
   */
  getDirectories(): OpenPackageDirectories {
    return this.openPackageDirs;
  }

}

// Create and export a singleton instance
export const configManager = new ConfigManager();

// Export the class for testing purposes
export { ConfigManager };
