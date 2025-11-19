# OpenPackage

<a href="https://www.npmjs.com/package/pnpkg" target="blank">
  <img src="https://img.shields.io/npm/v/pnpkg?style=flat-square" alt="Npm package for OpenPackage">
</a>
<a href="https://discord.gg/W5H54HZ8Fm"  target="blank">
  <img src="https://img.shields.io/badge/Discord-%235865F2.svg?&logo=discord&logoColor=white&style=flat-square" alt="OpenPackage Discord">
</a>
<br /><br />

OpenPackage is the package manager for AI coding.

Save and sync rules, slash commands, agents, and more.  
Build reusable packages for use across multiple projects and AI coding platforms.

Learn more in the official docs: [openpackage.dev/docs](https://openpackage.dev/docs).

Looking to discover, download, or publish formulas?  
Check out the official OpenPackage registry: [openpackage.dev/packages](https://openpackage.dev/packages). 

> [!NOTE]  
> For latest news and updates, follow the creator's X (Twitter) account
> [@hyericlee](https://x.com/hyericlee)

## Installation

npm
```bash
npm install -g pnpkg
```
## Use Cases

### Reuse files across multiple codebases
Reuse rules, slash commands, and more across multiple codebases.
```bash title="Terminal"
# In current codebase
pnpkg save essentials
# In another codebase
pnpkg install essentials
```  

> [!NOTE]  
> You can also use command `openpackage` instead of `pnpkg`

### Sync files across multiple platforms
Automatically sync your rules, slash commands, and more across multiple platform.
```bash title="Terminal"
# Current codebase has .cursor, .claude, .opencode directories
pnpkg save essentials .cursor/commands/essentials
# OpenPackage CLI automatically generates/syncs the same command files across all platforms.

# Before save:
# .cursor/commands/essentials/clean-code.md

# After save:
# .cursor/commands/essentials/clean-code.md
# .claude/commands/essentials/clean-code.md
# .opencode/command/essentials/clean-code.md
```  

### Modular management of files
Create domain specific formulas for modular reuse.
```bash title="Terminal"
# Create typescript formula
pnpkg add typescript .cursor/rules/typescript
pnpkg save typescript

# Create scalable-nextjs formula
pnpkg add scalable-nextjs .cursor/rules/nextjs
pnpkg save scalable-nextjs

# Create scalable-nestjs formula
pnpkg add scalable-nestjs .cursor/rules/nestjs
pnpkg save scalable-nestjs

# Create mongodb formula
pnpkg add mongodb .cursor/rules/mongodb
pnpkg save mongodb

# In your NextJS codebase
pnpkg install typescript
pnpkg install scalable-nextjs

# In your NestJS codebase
pnpkg install typescript
pnpkg install scalable-nestjs
pnpkg install mongodb
```  

## Usage

> [!TIP]  
> Formulas are essential to how OpenPackage works. We highly recommend reading [What are Formulas?](https://openpackage.dev/docs/what-are-formulas) to understand how formulas work.

### Add files/dirs to formula
```bash title="Terminal"
pnpkg add <formula-name> <path-to-dir-or-file>
```  
Adds dirs or files to the formula.  

### Save a formula
```bash title="Terminal"
pnpkg save <formula-name>
```  
Save the set of dirs and files as a formula for reuse and cross-platform sync.

### List formulas
```bash title="Terminal"
pnpkg list
```  
Use the list command to show all formulas currently saved to the local registry.  

### Show formula details
```bash title="Terminal"
pnpkg show <formula-name>
```  
The show command outputs the details of the formula and lists all included files.

### Install a formula
```bash title="Terminal"
pnpkg install <formula-name>
```  
Use the install command to add all files under the specified formula to the codebase at cwd.

### Uninstall a formula
```bash title="Terminal"
pnpkg uninstall <formula-name>
```  
Use the uninstall command to remove all files for the specified formula from the codebase at cwd.

> [!TIP]  
> Learn more by heading over to the [official docs](https://openpackage.dev/docs).

## Supported Platforms

OpenPackage performs installation and platform sync of files for supported AI coding platforms outlined by the table below.  
Files and paths will be automatically converted to platform specific designations during `save` and `install`.

> [!NOTE]  
> OpenPackage only searches and includes markdown files under supported platform directories and the root `ai/` directory.

| Platform | Directory | Root file | Rules | Commands | Agents | Skills |
| --- | --- | --- | --- | --- | --- | --- |
| Augment Code | .augment/ | | rules/ | commands/ | | |
| Claude Code | .claude/ | CLAUDE.md | | commands/ | agents/ | skills/ |
| Codex | .codex/ | AGENTS.md | | prompts/ | | |
| Cursor | .cursor/ | AGENTS.md | rules/ | commands/ | | |
| Factory | .factory/ | AGENTS.md | | commands/ | droids/ | |
| Kilo Code | .kilocode/ | AGENTS.md | rules/ | workflows/ | | |
| Kiro | .kiro/ | | steering/ | | | |
| OpenCode | .opencode/ | AGENTS.md | | command/ | agent/ | |
| Qwen Code | .qwen/ | QWEN.md | | | agents/ | |
| Roo | .roo/ | AGENTS.md | | commands/ | | |
| Warp | .warp/ | WARP.md | | | |
| Windsurf | .windsurf/ | | rules/ | | | |

## Contributing

We would love your help building the future of package management for AI coding.  

Feel free to create [PRs](https://github.com/enulus/OpenPackage/pulls) and [Github issues](https://github.com/enulus/OpenPackage/issues) for:
- Bugs
- Feature requests
- Support for new platforms
- Missing standard behavior
- Documentation

## Links

- [Official Website and Registry](https://openpackage.dev)
- [Documentation](https://openpackage.dev/docs)
- [Discord](https://discord.gg/W5H54HZ8Fm)
- [Creator X (Twitter)](https://x.com/hyericlee)
