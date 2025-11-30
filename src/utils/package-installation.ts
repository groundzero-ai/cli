import { logger } from './logger.js';
import { promptPlatformSelection } from './prompts.js';
import { getDetectedPlatforms, type Platform } from '../core/platforms.js';

/**
 * Detect existing platforms in the project
 * Wrapper around getDetectedPlatforms that adds debug logging
 */
export async function detectPlatforms(targetDir: string): Promise<Platform[]> {
  const detectedPlatforms = await getDetectedPlatforms(targetDir);

  if (detectedPlatforms.length > 0) {
    logger.debug(`Auto-detected platforms: ${detectedPlatforms.join(', ')}`);
  }

  return detectedPlatforms;
}

/**
 * Prompt user for platform selection when no platforms are detected
 */
export async function promptForPlatformSelection(): Promise<Platform[]> {
  console.log('\n🤖 Platform Detection');
  console.log('No AI development platform detected in this project.');

  return (await promptPlatformSelection()) as Platform[];
}
