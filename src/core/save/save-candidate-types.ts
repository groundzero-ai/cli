export type SaveCandidateSource = 'local' | 'workspace';

export interface SaveCandidate {
  source: SaveCandidateSource;
  registryPath: string;
  fullPath: string;
  content: string;
  contentHash: string;
  mtime: number;
  displayPath: string;
  /** Root file section body when applicable */
  sectionBody?: string;
  /** Indicates the candidate represents a root file chunk */
  isRootFile?: boolean;
  /** Original file content when different from `content` */
  originalContent?: string;
}

