# GroundZero Package Manager

<a href="https://www.npmjs.com/package/@groundzero-ai/gpm" target="blank">
  <img src="https://img.shields.io/npm/v/@groundzero-ai/gpm?style=flat-square" alt="Npm package for GroundZero package manager">
</a>
<a href="https://discord.gg/MBvaEw9n"  target="blank">
  <img src="https://img.shields.io/badge/Discord-%235865F2.svg?&logo=discord&logoColor=white&style=flat-square" alt="GroundZero Discord">
</a>
<br /><br />

GroundZero (g0) is the package manager for AI coding.

Save and sync rules, slash commands, agents, and more.  
Build reusable formulas for use across multiple projects and AI coding platforms.

Learn more in the [official documentation](https://groundzero.enulus.com/docs).

Looking to discover, download, or publish formulas?  
The GroundZero registry is currently in private beta, [signup for early access](https://tally.so/r/wzaerk). 

> [!NOTE]  
> For latest news and updates, follow the creator's X (Twitter) account
> [@hyericlee](https://x.com/hyericlee)
> or official [@groundzero_ai](https://x.com/groundzero_ai)

## Installation

npm
```bash
npm install -g @groundzero-ai/gpm
```
## Use Cases

### Reuse files across multiple codebases
Reuse rules, slash commands, and more across multiple codebases.
```bash title="Terminal"
# In current codebase
g0 save essentials
# In another codebase
g0 install essentials
```  

### Sync files across multiple platforms
Automatically sync your rules, slash commands, and more across multiple platform.
```bash title="Terminal"
# Current codebase has .cursor, .claude, .opencode directories
g0 save essentials .cursor/commands/essentials
# GroundZero CLI automatically generates/syncs the same command files accross all platforms.

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
g0 tag typescript .cursor/rules/typescript
g0 save typescript

# Create scalable-nextjs formula
g0 tag scalable-nextjs .cursor/rules/nextjs
g0 save scalable-nextjs

# Create scalable-nestjs formula
g0 tag scalable-nestjs .cursor/rules/nestjs
g0 save scalable-nestjs

# Create mongodb formula
g0 tag mongodb .cursor/rules/mongodb
g0 save mongodb

# In your NextJS codebase
g0 install typescript
g0 install scalable-nextjs

# In your NestJS codebase
g0 install typescript
g0 install scalable-nestjs
g0 install mongodb
```  

## Usage

> [!TIP]  
> Formulas are essential to how GroundZero works. We highly recommend reading [What are Formulas?](https://groundzero.enulus.com/docs/what-are-formulas) to understand how formulas work.

### Associate files and dirs with a formula 
```bash title="Terminal"
g0 tag <formula-name> <path-to-dir-or-file>
```  
Mark dirs or files as part of a formula for saving.  

### Save a formula
```bash title="Terminal"
g0 save <formula-name>
```  
Save a set of dirs and files in a codebase under the specified directory as a formula for reuse and cross-platform sync.

### List formulas
```bash title="Terminal"
g0 list
```  
Use the list command to show all formulas currently saved to the local registry.  

### Show formula details
```bash title="Terminal"
g0 show <formula-name>
```  
The show command outputs the details of the formula and lists all included files.

### Install a formula
```bash title="Terminal"
g0 install <formula-name>
```  
Use the install command to add all files under the specified formula to the codebase at cwd.

### Uninstall a formula
```bash title="Terminal"
g0 uninstall <formula-name>
```  
Use the uninstall command to remove all files for the specified formula from the codebase at cwd.

> [!TIP]  
> Learn more by heading over to the [official docs](https://groundzero.enulus.com/docs).

## Supported Platforms

GroundZero performs installation and platform sync of files for supported AI coding platforms outlined by the table below.  
Files and paths will be automatically converted to platform specific designations during `save` and `install`.

> [!NOTE]  
> GroundZero only searches and includes markdown files under supported platform directories and the root `ai/` directory.

| Platform | Directory | Root file | Rules | Commands | Agents |
| --- | --- | --- | --- | --- | --- |
| Augment Code | .augment/ | | rules/ | commands/ |  |
| Claude Code | .claude/ | CLAUDE.md | | commands/ | agents/ |
| Codex | .codex/ | AGENTS.md | | prompts/ | |
| Cursor | .cursor/ | AGENTS.md | rules/ | commands/ | |
| Factory | .factory/ | AGENTS.md | | commands/ | droids/ |
| Kilo Code | .kilocode/ | AGENTS.md | rules/ | workflows/ | | 
| Kiro | .kiro/ | | steering/ |  | |
| OpenCode | .opencode/ | AGENTS.md | | command/ | agent/ |
| Qwen Code | .qwen/ | QWEN.md | | | agents/ |
| Roo | .roo/ | AGENTS.md | | commands/ | |
| Warp | .warp/ | WARP.md | | |
| Windsurf | .windsurf/ | | rules/ |  | |

## Contributing

We would love your help building the future of package management for AI coding.  

Feel free to create [PRs](https://github.com/groundzero-ai/gpm/pulls) and [Github issues](https://github.com/groundzero-ai/gpm/issues) for:
- Bugs
- Feature requests
- Support for new platforms
- Missing standard behavior
- Documentation

## Links

- [Official Website](https://groundzero.enulus.com)
- [Documentation](https://groundzero.enulus.com/docs)
- [Discord](https://discord.gg/MBvaEw9n)
- [X (Twitter)](https://x.com/groundzero_ai)