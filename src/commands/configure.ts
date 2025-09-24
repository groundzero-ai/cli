import { Command } from 'commander';
import { CommandResult } from '../types/index.js';
import { profileManager } from '../core/profiles.js';
import { authManager } from '../core/auth.js';
import { ensureG0Directories } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling } from '../utils/errors.js';
import prompts from 'prompts';

/**
 * Configure command implementation for profile management
 */

interface ConfigureOptions {
  profile?: string;
  list?: boolean;
  delete?: boolean;
}

/**
 * Interactive profile setup
 */
async function setupProfile(profileName: string): Promise<CommandResult> {
  try {
    logger.info(`Setting up profile: ${profileName}`);

    // Ensure directories exist
    await ensureG0Directories();

    // Prompt for API key
    const response = await prompts([
      {
        type: 'password',
        name: 'apiKey',
        message: `Enter API key for profile '${profileName}':`,
        validate: (value: string) => value.length > 0 || 'API key is required'
      },
      {
        type: 'text',
        name: 'description',
        message: `Enter description for profile '${profileName}' (optional):`,
        initial: profileName === 'default' ? 'Default profile' : ''
      }
    ]);

    if (!response.apiKey) {
      console.log('❌ Profile setup cancelled');
      return { success: false, error: 'Profile setup cancelled' };
    }

    // Set profile configuration
    await profileManager.setProfile(profileName, {
      description: response.description || undefined
    });

    // Set profile credentials
    await profileManager.setProfileCredentials(profileName, {
      api_key: response.apiKey
    });

    console.log(`✅ Profile '${profileName}' configured successfully`);
    
    if (profileName === 'default') {
      console.log('');
      console.log('💡 You can now use:');
      console.log('  g0 push <formula-name>');
      console.log('  g0 pull <formula-name>');
    } else {
      console.log('');
      console.log('💡 You can now use:');
      console.log(`  g0 push <formula-name> --profile ${profileName}`);
      console.log(`  g0 pull <formula-name> --profile ${profileName}`);
    }

    return {
      success: true,
      data: {
        profile: profileName,
        message: 'Profile configured successfully'
      }
    };
  } catch (error) {
    logger.error(`Failed to setup profile: ${profileName}`, { error });
    return { success: false, error: `Failed to setup profile: ${error}` };
  }
}

/**
 * List all profiles
 */
async function listProfiles(): Promise<CommandResult> {
  try {
    const profiles = await profileManager.listProfiles();
    
    if (profiles.length === 0) {
      console.log('No profiles configured.');
      console.log('');
      console.log('To create a profile, run:');
      console.log('  g0 configure');
      console.log('  g0 configure --profile <name>');
      return { success: true, data: { profiles: [] } };
    }

    console.log('Configured profiles:');
    console.log('');

    for (const profileName of profiles) {
      const profile = await profileManager.getProfile(profileName);
      const hasCredentials = !!profile?.credentials?.api_key;
      const description = profile?.config?.description || '(no description)';
      
      console.log(`  ${profileName}`);
      console.log(`    Description: ${description}`);
      console.log(`    Credentials: ${hasCredentials ? '✅ Configured' : '❌ Missing'}`);
      console.log('');
    }

    return {
      success: true,
      data: { profiles }
    };
  } catch (error) {
    logger.error('Failed to list profiles', { error });
    return { success: false, error: `Failed to list profiles: ${error}` };
  }
}

/**
 * Delete a profile
 */
async function deleteProfile(profileName: string): Promise<CommandResult> {
  try {
    if (profileName === 'default') {
      console.log('❌ Cannot delete the default profile');
      return { success: false, error: 'Cannot delete the default profile' };
    }

    const exists = await profileManager.hasProfile(profileName);
    if (!exists) {
      console.log(`❌ Profile '${profileName}' not found`);
      return { success: false, error: 'Profile not found' };
    }

    // Confirm deletion
    const response = await prompts({
      type: 'confirm',
      name: 'confirm',
      message: `Are you sure you want to delete profile '${profileName}'?`,
      initial: false
    });

    if (!response.confirm) {
      console.log('Profile deletion cancelled');
      return { success: true, data: { message: 'Deletion cancelled' } };
    }

    await profileManager.deleteProfile(profileName);
    console.log(`✅ Profile '${profileName}' deleted successfully`);

    return {
      success: true,
      data: {
        profile: profileName,
        message: 'Profile deleted successfully'
      }
    };
  } catch (error) {
    logger.error(`Failed to delete profile: ${profileName}`, { error });
    return { success: false, error: `Failed to delete profile: ${error}` };
  }
}

/**
 * Show authentication status
 */
async function showAuthStatus(): Promise<CommandResult> {
  try {
    const authInfo = await authManager.getAuthInfo();
    const registryUrl = authManager.getRegistryUrl();

    console.log('Authentication Status:');
    console.log('');
    console.log(`  Profile: ${authInfo.profile}`);
    console.log(`  API Key: ${authInfo.hasApiKey ? '✅ Found' : '❌ Missing'}`);
    console.log(`  Registry URL: ${authInfo.hasRegistryUrl ? '✅ Found' : '❌ Missing'}`);
    console.log(`  Source: ${authInfo.source}`);
    
    if (registryUrl) {
      console.log(`  Registry: ${registryUrl}`);
    }

    console.log('');

    if (!authInfo.hasApiKey) {
      console.log('❌ No API key found. Configure a profile:');
      console.log('  g0 configure');
      console.log('  g0 configure --profile <name>');
    }

    if (!authInfo.hasRegistryUrl) {
      console.log('❌ G0_REGISTRY_URL environment variable not set');
      console.log('  export G0_REGISTRY_URL=https://your-registry.com');
    }

    if (authInfo.hasApiKey && authInfo.hasRegistryUrl) {
      console.log('✅ Authentication is properly configured');
    }

    return {
      success: true,
      data: authInfo
    };
  } catch (error) {
    logger.error('Failed to show auth status', { error });
    return { success: false, error: `Failed to show auth status: ${error}` };
  }
}

/**
 * Main configure command implementation
 */
async function configureCommand(options: ConfigureOptions): Promise<CommandResult> {
  logger.info('Configure command executed', { options });

  // List profiles
  if (options.list) {
    return await listProfiles();
  }

  // Delete profile
  if (options.delete && options.profile) {
    return await deleteProfile(options.profile);
  }

  // Show auth status (default behavior)
  if (!options.profile) {
    return await showAuthStatus();
  }

  // Setup profile
  return await setupProfile(options.profile);
}

/**
 * Setup the configure command
 */
export function setupConfigureCommand(program: Command): void {
  program
    .command('configure')
    .description('Configure profiles and authentication')
    .option('--profile <name>', 'profile name to configure')
    .option('--list', 'list all configured profiles')
    .option('--delete', 'delete the specified profile')
    .action(withErrorHandling(async (options: ConfigureOptions) => {
      const result = await configureCommand(options);
      if (!result.success) {
        throw new Error(result.error || 'Configure operation failed');
      }
    }));
}
