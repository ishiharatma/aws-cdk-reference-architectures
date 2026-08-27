module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': [
      '@swc/jest',
      {
        jsc: {
          parser: { syntax: 'typescript', tsx: false, decorators: true },
          target: 'es2022',
        },
      },
    ],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  collectCoverageFrom: [
    'lib/**/*.ts',
    '!lib/**/*.d.ts',
    '!lib/**/*.test.ts'
  ],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  moduleNameMapper: {
    '^lib/(.*)$': '<rootDir>/lib/$1',
    '^parameters/(.*)$': '<rootDir>/parameters/$1',
    '^test/(.*)$': '<rootDir>/test/$1',
    '^@common/(.*)$': '<rootDir>/../../common/$1',
    '^cdk\\.json$': '<rootDir>/cdk.json'
  }
};
