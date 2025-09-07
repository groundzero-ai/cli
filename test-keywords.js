import { promptFormulaDetails } from './dist/utils/prompts.js';

// Simulate the prompt response with space-separated keywords
async function testKeywordProcessing() {
  console.log('Testing keyword processing logic...');
  
  // Mock the prompts response
  const mockResponse = {
    name: 'test-formula',
    version: '1.0.0',
    description: 'Test formula',
    keywords: 'nestjs scalable api typescript backend',
    private: false
  };
  
  // Process keywords manually to test the logic
  const keywordsArray = mockResponse.keywords 
    ? mockResponse.keywords.trim().split(/\s+/).filter(k => k.length > 0)
    : [];
    
  console.log('Input keywords string:', mockResponse.keywords);
  console.log('Processed keywords array:', keywordsArray);
  console.log('Expected flow style:', `keywords: [${keywordsArray.join(', ')}]`);
}

testKeywordProcessing().catch(console.error);
