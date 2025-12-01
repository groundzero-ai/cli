import assert from 'node:assert/strict';

const { mapUniversalToPlatform } = await import(
  new URL('../src/utils/platform-mapper.js', import.meta.url).href
);
const { UNIVERSAL_SUBDIRS } = await import(
  new URL('../src/constants/index.js', import.meta.url).href
);
const { logger } = await import(
  new URL('../src/utils/logger.js', import.meta.url).href
);

console.log('platform extension filter tests starting');

const warnings: string[] = [];
const originalWarn = logger.warn;
(logger as any).warn = ((message: string, meta?: any) => {
  const renderedMeta = meta ? JSON.stringify(meta) : '';
  warnings.push(`${message}${renderedMeta}`);
}) as typeof logger.warn;

try {
  assert.throws(
    () => mapUniversalToPlatform('claude', UNIVERSAL_SUBDIRS.AGENTS, 'foo.yml'),
    /extension/i,
    'disallowed extensions should throw'
  );
  assert.ok(
    warnings.some(message => message.includes('foo.yml')),
    'should log warning when disallowing extension'
  );

  const warningCount = warnings.length;
  const mapped = mapUniversalToPlatform('claude', UNIVERSAL_SUBDIRS.AGENTS, 'foo.md');
  assert.ok(
    mapped.absFile.endsWith('.claude/agents/foo.md'),
    'allowed extensions should map to platform directory'
  );
  assert.equal(
    warnings.length,
    warningCount,
    'allowed extension should not add new warnings'
  );

  console.log('platform extension filter tests passed');
} finally {
  (logger as any).warn = originalWarn;
}


