import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const templatesDir = join(__dirname, '../src/templates');
const outputFile = join(__dirname, '../src/utils/embedded-templates.ts');

// Read template files
const cursorGroundzero = readFileSync(join(templatesDir, 'cursor/groundzero.mdc'), 'utf8');
const cursorAi = readFileSync(join(templatesDir, 'cursor/ai.mdc'), 'utf8');
const generalGroundzero = readFileSync(join(templatesDir, 'general/groundzero.md'), 'utf8');
const generalAi = readFileSync(join(templatesDir, 'general/ai.md'), 'utf8');

// Generate TypeScript module
const output = `// Auto-generated file - do not edit manually
// Generated from src/templates/ directory

export const CURSOR_TEMPLATES = {
  'groundzero.mdc': ${JSON.stringify(cursorGroundzero)},
  'ai.mdc': ${JSON.stringify(cursorAi)},
} as const;

export const GENERAL_TEMPLATES = {
  'groundzero.md': ${JSON.stringify(generalGroundzero)},
  'ai.md': ${JSON.stringify(generalAi)},
} as const;

export type CursorTemplateFile = keyof typeof CURSOR_TEMPLATES;
export type GeneralTemplateFile = keyof typeof GENERAL_TEMPLATES;
export type Platform = 'cursor' | 'general';
`;

writeFileSync(outputFile, output);
console.log('✅ Template files bundled successfully');
