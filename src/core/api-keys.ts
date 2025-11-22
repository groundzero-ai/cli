import { AuthOptions } from '../types/index.js';
import { authManager } from './auth.js';
import { createHttpClient } from '../utils/http-client.js';

export interface ApiKeyInfo {
  id: string;
  name: string;
  keyPrefix: string;
  isActive: boolean;
  lastUsedAt?: string;
  user: {
    _id: string;
    username: string;
  };
}

/**
 * Fetch metadata about the currently authenticated API key.
 */
export async function getCurrentApiKeyInfo(
  authOptions: AuthOptions = {}
): Promise<ApiKeyInfo> {
  const { apiKey } = await authManager.validateAuth(authOptions);
  const httpClient = await createHttpClient(authOptions);

  return await httpClient.get<ApiKeyInfo>('/api-keys/me', {
    headers: {
      'X-API-Key': apiKey
    }
  });
}

/**
 * Resolve the username associated with the current API key.
 */
export async function getCurrentUsername(authOptions: AuthOptions = {}): Promise<string> {
  const apiKeyInfo = await getCurrentApiKeyInfo(authOptions);

  if (!apiKeyInfo.user?.username) {
    throw new Error('Unable to determine username from API key. Please verify your credentials.');
  }

  return apiKeyInfo.user.username;
}

