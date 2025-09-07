import { writeFormulaYml } from './dist/utils/formula-yml.js';
import { readTextFile } from './dist/utils/fs.js';

async function test() {
  const testConfig = {
    name: 'test-debug',
    version: '1.0.0',
    description: 'Testing keywords flow style',
    keywords: ['nestjs', 'scalable', 'api', 'typescript'],
    private: false
  };

  console.log('Original config:', testConfig);
  
  // Write the YAML
  await writeFormulaYml('./test-output.yml', testConfig);
  
  // Read the result
  const result = await readTextFile('./test-output.yml');
  console.log('Generated YAML:');
  console.log(result);
  console.log('--- End of YAML ---');
}

test().catch(console.error);