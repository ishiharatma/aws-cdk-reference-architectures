module.exports = {
  testEnvironment: 'node',
  reporters: ['default', ['jest-junit', { outputName: 'junit.xml' }]],
  collectCoverageFrom: ['src/**/*.js'],
};
