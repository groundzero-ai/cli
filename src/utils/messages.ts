/**
 * User-facing messages and notifications for the G0 CLI
 */

/**
 * Beta registry notification message
 * Displayed when users interact with remote registry features
 */
export const BETA_REGISTRY_MESSAGE = '💡 The GroundZero remote registry is currently in private beta, please sign up for access at \x1b[4mhttps://groundzero.enulus.com\x1b[0m';

/**
 * API key signup message
 * Displayed when prompting users to obtain an API key
 */
export const API_KEY_SIGNUP_MESSAGE = '💡 Obtain an API key by signing up at \x1b[4mhttps://groundzero.enulus.com\x1b[0m';

/**
 * Display the beta registry message to the console
 */
export function showBetaRegistryMessage(): void {
  console.log(BETA_REGISTRY_MESSAGE);
}

/**
 * Display the API key signup message to the console
 */
export function showApiKeySignupMessage(): void {
  console.log(API_KEY_SIGNUP_MESSAGE);
}
