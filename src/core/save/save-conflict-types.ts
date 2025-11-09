import type { SaveCandidate } from './save-candidate-types.js';

export interface SaveConflictResolution {
  selection: SaveCandidate;
  platformSpecific: SaveCandidate[];
}

