---
# GroundZero formula
formula:
  name: test-directory-behavior
---

# G0 GPM CLI

A basic CLI tool built with Node.js, Commander, and TypeScript.

## Features

- Built with TypeScript for type safety
- Uses Commander.js for CLI argument parsing
- Includes example commands and subcommands
- Development and production build scripts
- Executable binary configuration

## Installation

```bash
# Install dependencies
npm install

# Build the project
npm run build
```

## Usage

### Available Commands

- `greet <name> [--uppercase]` - Greet someone with optional uppercase formatting
- `info` - Display information about this CLI
- `config get <key>` - Get a configuration value
- `config set <key> <value>` - Set a configuration value

### Examples

```bash
# Using npm start
npm start -- greet "World" --uppercase
npm start -- info
npm start -- config get database-url
npm start -- config set theme dark

# Development mode (runs TypeScript directly)
npm run dev -- greet "Developer"
npm run dev -- --help

# Development with watch mode
npm run dev:watch
```

## Development

```bash
# Run in development mode
npm run dev

# Run with watch mode (restarts on file changes)
npm run dev:watch

# Build for production
npm run build

# Clean build artifacts
npm run clean
```

## Project Structure

```
├── src/
│   └── index.ts          # Main CLI source code
├── bin/
│   └── g0                # Executable script
├── dist/                 # Compiled JavaScript (generated)
├── package.json          # Project configuration
├── tsconfig.json         # TypeScript configuration
└── README.md            # This file
```

## Extending the CLI

To add new commands:

1. Open `src/index.ts`
2. Add new command using the Commander.js API:

```typescript
program
  .command('your-command')
  .description('Your command description')
  .argument('<arg>', 'argument description')
  .option('-o, --option', 'option description')
  .action((arg, options) => {
    // Your command logic here
    console.log(`Running command with arg: ${arg}`);
  });
```

3. Rebuild the project: `npm run build`
