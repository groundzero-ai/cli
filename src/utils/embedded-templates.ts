// Auto-generated file - do not edit manually
// Generated from src/templates/ directory

export const CURSOR_TEMPLATES = {
  'groundzero.mdc': "---\ndescription:\nglobs:\nalwaysApply: true\n---\n\n**INSTRUCTIONS: Always search and read through any relevant guidelines under the /ai directory before starting any task**\n\n# The /ai directory\n\n- **Description**: A /ai directory contains information for the directory of the code it is placed in. Information is provided in the form of markdown files. Follow the given information within these markdown files to construct and update the code for it's given scope.\n- **Scope**: A codebase may have multiple /ai directories, each scoped to their respective parent directories and children.\n  - Ex: /project/foo/bar/ai contains information for the set of code and child directories under /project/foo/bar.\n  - Ex: /project/foo/ai contains information for the set of code and child directories under /project/foo, including and applied to /project/foo/bar.\n- **Purpose**: The purpose of the provided information within the /ai directory is to ensure the maintainability, consistency, and scalability of the given software.\n\n**REMEMBER: Always search and read through any relevant guidelines under the /ai directory before starting any task**",
} as const;

export const CLAUDE_TEMPLATES = {
  'groundzero.md': "**INSTRUCTIONS: Always search and read through any relevant guidelines under the /ai directory before starting any task**\n\n# The /ai directory\n\n- **Description**: A /ai directory contains information for the directory of the code it is placed in. Information is provided in the form of markdown files. Follow the given information within these markdown files to construct and update the code for it's given scope.\n- **Scope**: A codebase may have multiple /ai directories, each scoped to their respective parent directories and children.\n  - Ex: /project/foo/bar/ai contains information for the set of code and child directories under /project/foo/bar.\n  - Ex: /project/foo/ai contains information for the set of code and child directories under /project/foo, including and applied to /project/foo/bar.\n- **Purpose**: The purpose of the provided information within the /ai directory is to ensure the maintainability, consistency, and scalability of the given software.\n\n**REMEMBER: Always search and read through any relevant guidelines under the /ai directory before starting any task**",
} as const;

export type CursorTemplateFile = keyof typeof CURSOR_TEMPLATES;
export type ClaudeTemplateFile = keyof typeof CLAUDE_TEMPLATES;
export type Platform = 'cursor' | 'claude';
