import { nanoid } from 'nanoid';

/**
 * Entity ID length
 */
const ENTITY_ID_LENGTH = 9;

/**
 * Generate a new entity ID using nanoid with 9 character length
 * This provides a consistent ID format across the application
 */
export function generateEntityId(): string {
  return nanoid(ENTITY_ID_LENGTH);
}

/**
 * Validate entity ID format (must be 9 chars, only word chars or hyphen)
 */
export function isValidEntityId(id: string): boolean {
  return typeof id === 'string' && id.length === ENTITY_ID_LENGTH && !/[^\w\-]/.test(id);
}
