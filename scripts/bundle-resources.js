import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const resourcesDir = join(__dirname, '../src/resources/rules');
const outputFile = join(__dirname, '../src/utils/embedded-resources.ts');

// Read resource files
const groundzeroContent = readFileSync(join(resourcesDir, 'groundzero.md'), 'utf8');
const aiContent = readFileSync(join(resourcesDir, 'ai.md'), 'utf8');

// Generate TypeScript module
const output = `// Auto-generated file - do not edit manually
// Generated from src/resources/rules/ directory

export const RESOURCES_RULES = {
  'groundzero.md': ${JSON.stringify(groundzeroContent)},
  'ai.md': ${JSON.stringify(aiContent)},
} as const;

export type ResourceRuleFile = keyof typeof RESOURCES_RULES;
export type Platform = 'cursor' | 'general';
`;

writeFileSync(outputFile, output);
console.log('✅ Resource files bundled successfully');
