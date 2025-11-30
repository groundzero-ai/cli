import { logger } from './logger.js';
import { promptPlatformSelection } from './prompts.js';
import { detectAllPlatforms } from '../core/platforms.js';

/**
 * Detect existing platforms in the project
 */
export async function detectPlatforms(targetDir: string): Promise<string[]> {
  const platformDetectionResults = await detectAllPlatforms(targetDir);
  const detectedPlatforms = platformDetectionResults
    .filter(result => result.detected)
    .map(result => result.name);

  if (detectedPlatforms.length > 0) {
    logger.debug(`Auto-detected platforms: ${detectedPlatforms.join(', ')}`);
  }

  return detectedPlatforms;
}

/**
 * Prompt user for platform selection when no platforms are detected
 */
export async function promptForPlatformSelection(): Promise<string[]> {
  console.log('\n🤖 Platform Detection');
  console.log('No AI development platform detected in this project.');

  return await promptPlatformSelection();
}
