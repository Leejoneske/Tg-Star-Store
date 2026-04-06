module.exports = {
  testEnvironment: 'node',
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'server.js',
    '**/*.js',
    '!node_modules/**',
    '!coverage/**',
    '!**/node_modules/**',
    '!tests/**'
  ],
  testMatch: ['**/tests/**/*.test.js'],
  verbose: true,
  bail: false,
  maxWorkers: 1,
  testTimeout: 30000
};
