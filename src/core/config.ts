import { join } from 'path';
import { G0Config, G0Directories } from '../types/index.js';
import { readJsonFile, writeJsonFile, exists } from '../utils/fs.js';
import { logger } from '../utils/logger.js';
import { ConfigError } from '../utils/errors.js';
import { getG0Directories } from './directory.js';

/**
 * Configuration management for the G0 CLI
 */

const CONFIG_FILE_NAME = 'config.json';

// Default configuration values
const DEFAULT_CONFIG: G0Config = {
  registryUrl: 'https://registry.g0formulas.com',
  defaultAuthor: undefined,
  defaultLicense: 'MIT',
  cacheTimeout: 3600000 // 1 hour in milliseconds
};

class ConfigManager {
  private config: G0Config | null = null;
  private configPath: string;
  private g0Dirs: G0Directories;

  constructor() {
    this.g0Dirs = getG0Directories();
    this.configPath = join(this.g0Dirs.config, CONFIG_FILE_NAME);
  }

  /**
   * Load configuration from file, create default if it doesn't exist
   */
  async load(): Promise<G0Config> {
    if (this.config) {
      return this.config;
    }

    try {
      if (await exists(this.configPath)) {
        logger.debug(`Loading config from: ${this.configPath}`);
        const fileConfig = await readJsonFile<G0Config>(this.configPath);
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
  async get<K extends keyof G0Config>(key: K): Promise<G0Config[K]> {
    const config = await this.load();
    return config[key];
  }

  /**
   * Set a configuration value
   */
  async set<K extends keyof G0Config>(key: K, value: G0Config[K]): Promise<void> {
    const config = await this.load();
    config[key] = value;
    this.config = config;
    await this.save();
    logger.info(`Configuration updated: ${key} = ${value}`);
  }

  /**
   * Get all configuration values
   */
  async getAll(): Promise<G0Config> {
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
      
      // Validate registry URL format if provided
      if (config.registryUrl && !this.isValidUrl(config.registryUrl)) {
        throw new ConfigError(`Invalid registry URL: ${config.registryUrl}`);
      }

      // Validate cache timeout
      if (config.cacheTimeout !== undefined && (config.cacheTimeout < 0 || !Number.isInteger(config.cacheTimeout))) {
        throw new ConfigError(`Invalid cache timeout: ${config.cacheTimeout}`);
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
   * Get G0 directories
   */
  getDirectories(): G0Directories {
    return this.g0Dirs;
  }

  private isValidUrl(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }
}

// Create and export a singleton instance
export const configManager = new ConfigManager();

// Export the class for testing purposes
export { ConfigManager };
