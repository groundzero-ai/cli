import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(__dirname, '../src/templates');
const outputFile = join(__dirname, '../src/utils/embedded-templates.ts');

// Read template files
const cursorGroundzero = readFileSync(join(templatesDir, 'cursor/groundzero.mdc'), 'utf8');
const claudeGroundzero = readFileSync(join(templatesDir, 'claude/groundzero.md'), 'utf8');

// Generate TypeScript module
const output = `// Auto-generated file - do not edit manually
// Generated from src/templates/ directory

export const CURSOR_TEMPLATES = {
  'groundzero.mdc': ${JSON.stringify(cursorGroundzero)},
} as const;

export const CLAUDE_TEMPLATES = {
  'groundzero.md': ${JSON.stringify(claudeGroundzero)},
} as const;

export type CursorTemplateFile = keyof typeof CURSOR_TEMPLATES;
export type ClaudeTemplateFile = keyof typeof CLAUDE_TEMPLATES;
export type Platform = 'cursor' | 'claude';
`;

writeFileSync(outputFile, output);
console.log('✅ Template files bundled successfully');
