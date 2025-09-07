// Test edge cases for keyword processing
console.log('Testing edge cases...');

function processKeywords(keywordsString) {
  return keywordsString 
    ? keywordsString.trim().split(/\s+/).filter(k => k.length > 0)
    : [];
}

// Test cases
const testCases = [
  'nestjs scalable api',           // Normal case
  '  nestjs   scalable   api  ',   // Extra spaces
  'single',                        // Single keyword
  '   single   ',                  // Single with spaces
  '',                              // Empty string
  '   ',                           // Only spaces
  'a b c d e f g',                 // Many keywords
];

testCases.forEach((input, i) => {
  const result = processKeywords(input);
  console.log(`Test ${i + 1}: "${input}" → [${result.join(', ')}]`);
});

console.log('\nAll tests completed!');
