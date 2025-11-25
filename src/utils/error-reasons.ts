/**
 * Extract a concise, user-friendly reason string from a raw error message.
 *
 * This is used to normalize low-level network / registry / fetch errors into
 * short labels that can be embedded in messages like:
 *   "Remote pull failed for `<pkg>` (reason: <reason>)"
 */
export function extractRemoteErrorReason(message: string): string {
  const normalized = (message || '').trim();

  if (!normalized) {
    return 'unknown error';
  }

  // Specific phrases we already emit elsewhere
  if (normalized.includes('not found in remote registry')) {
    return 'not found in remote registry';
  }
  if (/Access denied/i.test(normalized)) {
    return 'access denied';
  }
  if (/Network error/i.test(normalized)) {
    return 'network error';
  }
  if (/Integrity check failed/i.test(normalized)) {
    return 'integrity check failed';
  }

  // Common network / fetch failures
  if (/fetch failed/i.test(normalized)) {
    return 'network error';
  }
  if (/network|ENOTFOUND|ECONNREFUSED|ETIMEDOUT/i.test(normalized)) {
    return 'network error';
  }

  // Not found / HTTP 404 style errors
  if (/not found|404/i.test(normalized)) {
    return 'not found in remote registry';
  }

  // Access / auth errors
  if (/access denied|unauthorized|403|401/i.test(normalized)) {
    return 'access denied';
  }

  // Integrity / checksum issues
  if (/integrity|checksum/i.test(normalized)) {
    return 'integrity check failed';
  }

  // Fallback: return message if short enough, otherwise truncate
  if (normalized.length <= 50) {
    return normalized;
  }

  return `${normalized.slice(0, 47)}...`;
}


