import type { Platform } from '../platforms.js';

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
  /** Indicates the candidate maps back to a specific platform */
  platform?: Platform | 'ai';
  /** The parsed YAML frontmatter when file is markdown */
  frontmatter?: any;
  /** Raw frontmatter block text (without delimiters) */
  rawFrontmatter?: string;
  /** Markdown body without frontmatter */
  markdownBody?: string;
  /** Tracks whether the candidate originates from a markdown file */
  isMarkdown?: boolean;
}

