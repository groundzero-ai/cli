import { AuthOptions } from '../types/index.js';
import { profileManager } from './profiles.js';
import { logger } from '../utils/logger.js';
import { ConfigError } from '../utils/errors.js';
import { getVersion } from '../utils/package.js';

/**
 * Authentication management for G0 CLI
 * Handles credential resolution and validation
 */


class AuthManager {
  /**
   * Get API key following credential precedence:
   * 1. Command line options (--api-key)
   * 2. Profile credentials file
   * 3. Default profile
   */
  async getApiKey(options: AuthOptions = {}): Promise<string | null> {
    try {
      // 1. Command line API key override
      if (options.apiKey) {
        logger.debug('Using API key from command line options');
        return options.apiKey;
      }

      // 2. Profile-based authentication
      const profileName = options.profile || process.env.G0_PROFILE || 'default';
      logger.debug(`Using profile: ${profileName}`);

      const profile = await profileManager.getProfile(profileName);
      if (profile?.credentials?.api_key) {
        logger.debug(`Using API key from profile: ${profileName}`);
        return profile.credentials.api_key;
      }

      // 3. Try default profile if not already tried
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
      throw new ConfigError(`Failed to get API key: ${error}`);
    }
  }

  /**
   * Get registry URL from environment variable
   */
  getRegistryUrl(): string {
    const registryUrl = "https://g0backend.enulus.com";
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
        'No API key found. Please configure a profile with "g0 configure" or use --api-key option.'
      );
    }

    return { apiKey, registryUrl };
  }

  /**
   * Get current profile name being used
   */
  getCurrentProfile(options: AuthOptions = {}): string {
    return options.profile || process.env.G0_PROFILE || 'default';
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
      'Content-Type': 'application/json',
      'User-Agent': `g0-cli/${getVersion()}`
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
