import { join } from 'path';
import { Profile, ProfileConfig, ProfileCredentials } from '../types/index.js';
import { configManager } from './config.js';
import { getOpenPackageDirectories } from './directory.js';
import { readIniFile, writeIniFile, IniFile, setIniValue, removeIniSection, hasIniSection } from '../utils/ini.js';
import { logger } from '../utils/logger.js';
import { ConfigError } from '../utils/errors.js';

/**
 * Profile management for OpenPackage CLI
 * Handles profile configuration and credentials
 */

const CREDENTIALS_FILE_NAME = 'credentials';

class ProfileManager {
  private credentialsPath: string;
  private openPackageDirs: ReturnType<typeof getOpenPackageDirectories>;

  constructor() {
    this.openPackageDirs = getOpenPackageDirectories();
    this.credentialsPath = join(this.openPackageDirs.config, CREDENTIALS_FILE_NAME);
  }

  /**
   * List all available profiles
   */
  async listProfiles(): Promise<string[]> {
    try {
      const config = await configManager.getAll();
      const profiles = config.profiles || {};
      return Object.keys(profiles);
    } catch (error) {
      logger.error('Failed to list profiles', { error });
      throw new ConfigError(`Failed to list profiles: ${error}`);
    }
  }

  /**
   * Get a specific profile with its configuration and credentials
   */
  async getProfile(profileName: string): Promise<Profile | null> {
    try {
      const config = await configManager.getAll();
      const profiles = config.profiles || {};
      
      if (!profiles[profileName]) {
        return null;
      }

      const profileConfig = profiles[profileName];
      let credentials: ProfileCredentials | undefined;

      // Load credentials from credentials file
      try {
        const credentialsData = await readIniFile(this.credentialsPath);
        const apiKey = credentialsData[profileName]?.api_key;
        if (apiKey) {
          credentials = { api_key: apiKey };
        }
      } catch (error) {
        logger.debug(`No credentials found for profile: ${profileName}`, { error });
      }

      return {
        name: profileName,
        config: profileConfig,
        credentials
      };
    } catch (error) {
      logger.error(`Failed to get profile: ${profileName}`, { error });
      throw new ConfigError(`Failed to get profile: ${error}`);
    }
  }

  /**
   * Set or update a profile configuration
   */
  async setProfile(profileName: string, profileConfig: ProfileConfig): Promise<void> {
    try {
      const config = await configManager.getAll();
      
      if (!config.profiles) {
        config.profiles = {};
      }
      
      config.profiles[profileName] = profileConfig;
      
      // Update the config using the existing configManager
      await configManager.set('profiles' as keyof typeof config, config.profiles);
      
      logger.info(`Profile '${profileName}' configuration updated`);
    } catch (error) {
      logger.error(`Failed to set profile: ${profileName}`, { error });
      throw new ConfigError(`Failed to set profile: ${error}`);
    }
  }

  /**
   * Set credentials for a profile
   */
  async setProfileCredentials(profileName: string, credentials: ProfileCredentials): Promise<void> {
    try {
      let credentialsData: IniFile = {};
      
      // Read existing credentials if file exists
      try {
        credentialsData = await readIniFile(this.credentialsPath);
      } catch (error) {
        logger.debug('Credentials file does not exist, creating new one');
      }
      
      // Set the API key for the profile
      setIniValue(credentialsData, profileName, 'api_key', credentials.api_key);
      
      // Write back to file
      await writeIniFile(this.credentialsPath, credentialsData);
      
      logger.info(`Credentials for profile '${profileName}' updated`);
    } catch (error) {
      logger.error(`Failed to set credentials for profile: ${profileName}`, { error });
      throw new ConfigError(`Failed to set credentials for profile: ${error}`);
    }
  }

  /**
   * Delete a profile and its credentials
   */
  async deleteProfile(profileName: string): Promise<void> {
    try {
      // Remove from config
      const config = await configManager.getAll();
      if (config.profiles && config.profiles[profileName]) {
        delete config.profiles[profileName];
        await configManager.set('profiles' as keyof typeof config, config.profiles);
      }
      
      // Remove credentials
      try {
        const credentialsData = await readIniFile(this.credentialsPath);
        if (hasIniSection(credentialsData, profileName)) {
          removeIniSection(credentialsData, profileName);
          await writeIniFile(this.credentialsPath, credentialsData);
        }
      } catch (error) {
        logger.debug('No credentials file to update');
      }
      
      logger.info(`Profile '${profileName}' deleted`);
    } catch (error) {
      logger.error(`Failed to delete profile: ${profileName}`, { error });
      throw new ConfigError(`Failed to delete profile: ${error}`);
    }
  }

  /**
   * Check if a profile exists
   */
  async hasProfile(profileName: string): Promise<boolean> {
    try {
      const config = await configManager.getAll();
      return !!(config.profiles && config.profiles[profileName]);
    } catch (error) {
      logger.error(`Failed to check if profile exists: ${profileName}`, { error });
      return false;
    }
  }

  /**
   * Get the default profile name
   */
  async getDefaultProfileName(): Promise<string> {
    return 'default';
  }

  /**
   * Get credentials file path
   */
  getCredentialsPath(): string {
    return this.credentialsPath;
  }

  /**
   * Get OpenPackage directories
   */
  getDirectories(): ReturnType<typeof getOpenPackageDirectories> {
    return this.openPackageDirs;
  }
}

// Create and export a singleton instance
export const profileManager = new ProfileManager();

// Export the class for testing purposes
export { ProfileManager };
