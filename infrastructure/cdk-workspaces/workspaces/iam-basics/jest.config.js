module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.tsx?$': 'ts-jest'
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