/**
 * User-facing messages and notifications for the OpenPackage CLI
 */

/**
 * API key signup message
 * Displayed when prompting users to obtain an API key
 */
export const API_KEY_SIGNUP_MESSAGE = '💡 Obtain an API key by signing up at \x1b[4mhttps://openpackage.dev\x1b[0m';

/**
 * Display the API key signup message to the console
 */
export function showApiKeySignupMessage(): void {
  console.log(API_KEY_SIGNUP_MESSAGE);
}
