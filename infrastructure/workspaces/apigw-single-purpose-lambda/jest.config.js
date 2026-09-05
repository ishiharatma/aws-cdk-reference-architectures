module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.test.ts"],
  transform: {
    "^.+\.tsx?$": "ts-jest",
  },
  moduleNameMapper: {
    "^lib/(.*)$": "<rootDir>/lib/$1",
    "^parameters/(.*)$": "<rootDir>/parameters/$1",
    "^test/(.*)$": "<rootDir>/test/$1",
    "^@common/(.*)$": "<rootDir>/../../common/$1",
  },
};
