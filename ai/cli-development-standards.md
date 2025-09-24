---
# CLI Development Standards
formula:
  name: cli-development-standards
  version: 1.0.0
  description: Standards and guidelines for G0 CLI development
---

# G0 CLI Development Standards

## User Cancellation Handling

### Standard Pattern
All interactive commands must handle user cancellation (ESC key) gracefully:

```typescript
import { safePrompts } from '../utils/prompts.js';
import { withErrorHandling, UserCancellationError } from '../utils/errors.js';

// ✅ CORRECT: Use safePrompts for all interactive prompts
const response = await safePrompts({
  type: 'text',
  name: 'input',
  message: 'Enter value:'
});

// ✅ CORRECT: Use withErrorHandling wrapper for commands
export function setupCommand(program: Command): void {
  program
    .command('command-name')
    .action(withErrorHandling(async (options) => {
      const result = await commandFunction(options);
      if (!result.success) {
        throw new Error(result.error || 'Command failed');
      }
    }));
}
```

### ❌ Anti-Patterns
```typescript
// ❌ WRONG: Direct prompts() calls without cancellation handling
const response = await prompts({...});

// ❌ WRONG: Manual cancellation checks
if (!response.value) {
  return { success: false, error: 'Cancelled' };
}

// ❌ WRONG: Not using withErrorHandling wrapper
.action(async (options) => {
  // Direct command logic without error handling
});
```

## Error Handling Standards

### Command Structure
All commands must follow this structure:

1. **Import required utilities**:
   - `safePrompts` for interactive prompts
   - `withErrorHandling` for error handling
   - `UserCancellationError` for cancellation

2. **Command function**:
   - Return `CommandResult` type
   - Handle business logic errors gracefully
   - Let `UserCancellationError` bubble up

3. **Command setup**:
   - Use `withErrorHandling` wrapper
   - Throw errors for failed operations

### Error Types
- **User Cancellation**: Use `UserCancellationError` - exits cleanly
- **Business Logic**: Return `{ success: false, error: string }`
- **System Errors**: Let them bubble up to be caught by `withErrorHandling`

### Critical Pattern: Re-throwing UserCancellationError
When using try-catch blocks in command functions, always re-throw `UserCancellationError`:

```typescript
async function commandFunction(): Promise<CommandResult> {
  try {
    // Command logic that might throw UserCancellationError
    await safePrompts({...});
    
    return { success: true, data: result };
  } catch (error) {
    if (error instanceof UserCancellationError) {
      throw error; // ✅ CRITICAL: Re-throw to be handled by withErrorHandling
    }
    // Handle other errors normally
    logger.error('Command failed', { error });
    return { success: false, error: `Command failed: ${error}` };
  }
}
```

**❌ Common Mistake**: Catching `UserCancellationError` and converting to regular error:
```typescript
// ❌ WRONG: This will show verbose errors instead of clean exit
} catch (error) {
  return { success: false, error: `Failed: ${error}` };
}
```

## Testing Standards

### Interactive Commands
Test user cancellation scenarios:
- ESC key handling
- Clean exit without verbose errors
- Proper error messages for actual failures

### Error Handling
Verify:
- User cancellation exits with code 0
- Business errors show appropriate messages
- System errors are logged with context

## File Organization

### Commands (`src/commands/`)
- One file per command
- Export `setupCommandName()` function
- Use utility functions from `src/utils/`

### Utilities (`src/utils/`)
- `prompts.ts`: All prompt-related utilities
- `errors.ts`: Error handling and custom error classes
- `logger.ts`: Logging utilities

### Core (`src/core/`)
- Business logic and data management
- Use utility functions for user interaction

## Development Guidelines

1. **Always use `safePrompts()`** instead of direct `prompts()` calls
2. **Wrap all commands** with `withErrorHandling()`
3. **Test cancellation scenarios** during development
4. **Follow consistent error patterns** across all commands
5. **Use TypeScript types** for better error prevention

## Migration Guide

### Updating Existing Commands
1. Replace `import prompts from 'prompts'` with `import { safePrompts } from '../utils/prompts.js'`
2. Replace `await prompts(...)` with `await safePrompts(...)`
3. Remove manual cancellation checks (handled by `safePrompts`)
4. Ensure command uses `withErrorHandling` wrapper

### Adding New Commands
1. Follow the standard command structure
2. Use `safePrompts` for all interactive elements
3. Implement proper error handling
4. Test cancellation scenarios
5. Add to main program in `src/index.ts`
