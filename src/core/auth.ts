import { AuthOptions } from '../types/index.js';
import { profileManager } from './profiles.js';
import { logger } from '../utils/logger.js';
import { ConfigError } from '../utils/errors.js';
import { getVersion } from '../utils/package.js';

/**
 * Authentication management for OpenPackage CLI
 * Handles credential resolution and validation
 */


class AuthManager {
  /**
   * Get API key following credential precedence:
   * 1. Command line options (--api-key)
   * 2. Profile credentials file (explicit profile, env var, or default)
   * 
   * If an explicit profile is requested via options.profile but doesn't exist
   * or has no credentials, an error is thrown instead of falling back to default.
   */
  async getApiKey(options: AuthOptions = {}): Promise<string | null> {
    try {
      // 1. Command line API key override
      // Check if apiKey was explicitly provided (not undefined)
      if (options.apiKey !== undefined) {
        if (!options.apiKey || options.apiKey.trim() === '') {
          throw new ConfigError(
            'API key provided via --api-key is empty. Please provide a valid API key.'
          );
        }
        logger.debug('Using API key from command line options');
        return options.apiKey;
      }

      // 2. Profile-based authentication
      const profileName = options.profile || process.env.OPENPACKAGEPROFILE || 'default';
      const isExplicitProfile = !!options.profile; // Profile was explicitly requested
      logger.debug(`Using profile: ${profileName}${isExplicitProfile ? ' (explicit)' : ''}`);

      const profile = await profileManager.getProfile(profileName);
      if (profile?.credentials?.api_key) {
        logger.debug(`Using API key from profile: ${profileName}`);
        return profile.credentials.api_key;
      }

      // 3. If explicit profile was requested but doesn't exist or has no credentials, error
      if (isExplicitProfile) {
        if (!profile) {
          throw new ConfigError(
            `Profile '${profileName}' not found. Please configure it with "opn configure --profile ${profileName}"`
          );
        }
        if (!profile.credentials?.api_key) {
          throw new ConfigError(
            `Profile '${profileName}' has no API key configured. Please configure it with "opn configure --profile ${profileName}"`
          );
        }
      }

      // 4. Try default profile if not already tried (only for non-explicit profiles)
      if (profileName !== 'default') {
        const defaultProfile = await profileManager.getProfile('default');
        if (defaultProfile?.credentials?.api_key) {
          logger.debug('Using API key from default profile');
          return defaultProfile.credentials.api_key;
        }
      }

      logger.warn('No API key found in any credential source');
      return null;
    } catch (error) {
      logger.error('Failed to get API key', { error });
      if (error instanceof ConfigError) {
        throw error; // Re-throw ConfigError as-is
      }
      throw new ConfigError(`Failed to get API key: ${error}`);
    }
  }

  /**
   * Get registry URL
   */
  getRegistryUrl(): string {
    const registryUrl = "https://backend.openpackage.dev/v1";
    // const registryUrl = "http://localhost:3000/v1";
    logger.debug(`Using registry URL: ${registryUrl}`);
    return registryUrl;
  }

  /**
   * Validate that required authentication is available
   */
  async validateAuth(options: AuthOptions = {}): Promise<{ apiKey: string; registryUrl: string }> {
    const apiKey = await this.getApiKey(options);
    const registryUrl = this.getRegistryUrl();

    if (!apiKey) {
      throw new ConfigError(
        'No API key found. Please configure a profile with "opn configure" or use --api-key option.'
      );
    }

    return { apiKey, registryUrl };
  }

  /**
   * Get current profile name being used
   * Returns 'api-key' when API key is provided directly via command line
   */
  getCurrentProfile(options: AuthOptions = {}): string {
    // If API key is provided directly, it takes precedence over profile
    if (options.apiKey !== undefined && options.apiKey) {
      return '<api-key>';
    }
    return options.profile || process.env.OPENPACKAGEPROFILE || 'default';
  }

  /**
   * Check if authentication is configured
   */
  async isAuthenticated(options: AuthOptions = {}): Promise<boolean> {
    try {
      const apiKey = await this.getApiKey(options);
      const registryUrl = this.getRegistryUrl();
      return !!(apiKey && registryUrl);
    } catch (error) {
      logger.debug('Authentication check failed', { error });
      return false;
    }
  }

  /**
   * Get authentication headers for HTTP requests
   */
  async getAuthHeaders(options: AuthOptions = {}): Promise<Record<string, string>> {
    const { apiKey } = await this.validateAuth(options);
    
    return {
      'Authorization': `Bearer ${apiKey}`,
      'User-Agent': `openpackage-cli/${getVersion()}`
    };
  }

  /**
   * Get authentication info for debugging/logging (without exposing sensitive data)
   */
  async getAuthInfo(options: AuthOptions = {}): Promise<{
    profile: string;
    hasApiKey: boolean;
    hasRegistryUrl: boolean;
    source: string;
  }> {
    const profile = this.getCurrentProfile(options);
    const apiKey = await this.getApiKey(options);
    const registryUrl = this.getRegistryUrl();

    let source = 'none';
    if (options.apiKey) {
      source = 'command-line';
    } else if (apiKey) {
      source = 'profile';
    }

    return {
      profile,
      hasApiKey: !!apiKey,
      hasRegistryUrl: !!registryUrl,
      source
    };
  }
}

// Create and export a singleton instance
export const authManager = new AuthManager();

// Export the class for testing purposes
export { AuthManager };
