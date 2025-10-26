import { Command } from 'commander';
import { CommandResult } from '../types/index.js';
import { profileManager } from '../core/profiles.js';
import { ensureG0Directories } from '../core/directory.js';
import { logger } from '../utils/logger.js';
import { withErrorHandling, UserCancellationError } from '../utils/errors.js';
import { safePrompts } from '../utils/prompts.js';
import { showApiKeySignupMessage } from '../utils/messages.js';

/**
 * Configure command implementation for profile management
 */

interface ConfigureOptions {
  profile?: string;
  list?: boolean;
  delete?: string | boolean;
}

/**
 * Interactive profile setup
 */
async function setupProfile(profileName: string): Promise<CommandResult> {
  try {
    logger.info(`Setting up profile: ${profileName}`);

    // Ensure directories exist
    await ensureG0Directories();

    showApiKeySignupMessage();

    // Prompt for API key
    const response = await safePrompts([
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
      throw new UserCancellationError('Profile setup cancelled');
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
    if (error instanceof UserCancellationError) {
      throw error; // Re-throw to be handled by withErrorHandling
    }
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
      return { success: false, error: 'Cannot delete the default profile' };
    }

    const exists = await profileManager.hasProfile(profileName);
    if (!exists) {
      return { success: false, error: `Profile '${profileName}' not found` };
    }

    // Confirm deletion
    const response = await safePrompts({
      type: 'confirm',
      name: 'confirm',
      message: `Are you sure you want to delete profile '${profileName}'?`,
      initial: false
    });

    if (!response.confirm) {
      throw new UserCancellationError('Profile deletion cancelled');
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
    if (error instanceof UserCancellationError) {
      throw error; // Re-throw to be handled by withErrorHandling
    }
    logger.error(`Failed to delete profile: ${profileName}`, { error });
    return { success: false, error: `Failed to delete profile: ${error}` };
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
  if (typeof options.delete === 'string') {
    return await deleteProfile(options.delete);
  }
  if (options.delete && options.profile) {
    // Backward compatibility: allow --delete with --profile <name>
    return await deleteProfile(options.profile);
  }
  if (options.delete) {
    return { success: false, error: 'Please provide a profile name via --delete <name> or --profile <name>.' };
  }

  // Setup default profile (default behavior)
  if (!options.profile) {
    return await setupProfile('default');
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
    .description('Configure default profile and authentication')
    .option('--profile <name>', 'profile name to configure')
    .option('--list', 'list all configured profiles')
    .option('--delete <name>', 'delete the specified profile')
    .action(withErrorHandling(async (options: ConfigureOptions) => {
      const result = await configureCommand(options);
      if (!result.success) {
        throw new Error(result.error || 'Configure operation failed');
      }
    }));
}
