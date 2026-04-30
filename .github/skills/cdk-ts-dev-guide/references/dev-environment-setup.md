# CDK TypeScript 開発環境セットアップ

新規プロジェクトまたは既存プロジェクトへの参加時に必要な環境構築手順と設定テンプレート。

---

## 1. 前提条件

| ツール | バージョン | 用途 |
|--------|-----------|------|
| Node.js | 22 以降 | CDK / TypeScript 実行環境 |
| TypeScript | 3.8 以降 | 言語 |
| AWS CLI | 2.32.0 以降 | `aws login` / `aws sso login` 対応 |
| AWS CDK CLI | 最新 | `cdk synth` / `cdk deploy` |
| VSCode | 最新 | 推奨 IDE |

---

## 2. プロジェクト初期化

```bash
mkdir myproject && cd myproject
mkdir -p infra
cd infra
cdk init app --language typescript
```

### devDependencies（開発・テスト時のみ）

```bash
npm install --save-dev \
  @eslint/js \
  @types/jest @types/node \
  @typescript-eslint/eslint-plugin @typescript-eslint/parser \
  aws-cdk \
  cdk-nag \
  cross-env \
  eslint eslint-cdk-plugin eslint-config-prettier \
  eslint-plugin-prettier eslint-plugin-unused-imports eslint-plugin-jsdoc \
  husky lint-staged \
  jest ts-jest \
  prettier \
  rimraf \
  ts-node tsconfig-paths \
  typedoc \
  typescript typescript-eslint
```

### dependencies（synth 時に必要）

```bash
npm install \
  aws-cdk-lib \
  constructs \
  change-case-commonjs
```

> Lambda Python を使う場合: `npm install @aws-cdk/aws-lambda-python-alpha`

---

## 3. tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["es2022"],
    "declaration": true,
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noImplicitReturns": true,
    "inlineSourceMap": true,
    "inlineSources": true,
    "experimentalDecorators": true,
    "strictPropertyInitialization": false,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "baseUrl": "./",
    "paths": {
      "lib/*": ["lib/*"],
      "parameters/*": ["parameters/*"],
      "test/*": ["test/*"]
    }
  },
  "exclude": ["node_modules", "cdk.out"],
  "include": ["bin/**/*.ts", "lib/**/*.ts", "test/**/*.ts", "parameters/**/*.ts"],
  "ts-node": {
    "require": ["tsconfig-paths/register"]
  }
}
```

---

## 4. ESLint 設定（eslint.config.mjs）

CDK プロジェクト向けの Flat Config。`eslint-cdk-plugin` で CDK 固有のルールを適用。

```javascript
import pluginJs from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import unusedImportPlugin from "eslint-plugin-unused-imports";
import eslintCdkPlugin from "eslint-cdk-plugin";
import tseslint from "typescript-eslint";
import jsdoc from "eslint-plugin-jsdoc";

export default tseslint.config(
  { files: ["**/*.ts"] },
  { ignores: ["**/node_modules/**", "**/cdk.out/**", "**/*.js", "**/*.d.ts", "eslint.config.mjs"] },
  {
    languageOptions: {
      sourceType: "script",
      parserOptions: { projectService: true },
    },
  },
  pluginJs.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    plugins: {
      "unused-imports": unusedImportPlugin,
      cdk: eslintCdkPlugin,
      jsdoc: jsdoc,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": ["error", {
        vars: "all", varsIgnorePattern: "^_",
        args: "after-used", argsIgnorePattern: "^_",
      }],
      ...eslintCdkPlugin.configs.recommended.rules,
      "cdk/no-variable-construct-id": "off",
      "jsdoc/require-jsdoc": ["warn", {
        require: {
          FunctionDeclaration: true, MethodDefinition: true,
          ClassDeclaration: true, ArrowFunctionExpression: false,
        },
        contexts: ["TSInterfaceDeclaration", "TSTypeAliasDeclaration", "TSEnumDeclaration"],
      }],
      "jsdoc/require-description": "warn",
    },
  },
  prettierConfig
);
```

### 主要ルールの意図

| ルール | 意図 |
|--------|------|
| `eslint-cdk-plugin` | CDK 固有のアンチパターン検出（Construct ID 重複等） |
| `unused-imports` | 未使用 import の自動削除 |
| `jsdoc/require-jsdoc` | TypeDoc 生成のため class / interface / function に JSDoc 必須 |
| `prettierConfig` | フォーマットは Prettier に委任（ESLint のフォーマットルール無効化） |

---

## 5. Prettier 設定（.prettierrc）

```json
{
  "semi": true,
  "singleQuote": true,
  "tabWidth": 2,
  "useTabs": false,
  "trailingComma": "es5",
  "printWidth": 100,
  "arrowParens": "always"
}
```

---

## 6. Husky + lint-staged（pre-commit フック）

### セットアップ

```bash
npx husky init
```

### .husky/pre-commit

```bash
npm lint-staged
```

### package.json に追加

```json
{
  "lint-staged": {
    "*.{js,jsx,ts,tsx}": [
      "eslint --fix",
      "prettier --write"
    ]
  }
}
```

---

## 7. Jest 設定（jest.config.js）

```javascript
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test'],
  testMatch: ['**/*.test.ts'],
  transform: { '^.+\\.tsx?$': 'ts-jest' },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  collectCoverageFrom: ['lib/**/*.ts', '!lib/**/*.d.ts', '!lib/**/*.test.ts'],
  coverageDirectory: 'coverage',
  moduleNameMapper: {
    '^lib/(.*)$': '<rootDir>/lib/$1',
    '^parameters/(.*)$': '<rootDir>/parameters/$1',
    '^test/(.*)$': '<rootDir>/test/$1',
  },
};
```

> `moduleNameMapper` は tsconfig.json の `paths` と一致させること。

---

## 8. VSCode 設定（.vscode/settings.json）

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": "explicit"
  },
  "eslint.validate": ["typescript"],
  "typescript.tsdk": "infra/node_modules/typescript/lib"
}
```

### 推奨 VSCode 拡張機能

| 拡張機能 | 用途 |
|---------|------|
| `esbenp.prettier-vscode` | 保存時自動フォーマット |
| `dbaeumer.vscode-eslint` | ESLint リアルタイム検証 |
| `amazonwebservices.aws-toolkit-vscode` | AWS 認証・リソース参照 |

---

## 9. npm スクリプト（package.json）

```json
{
  "scripts": {
    "build": "tsc",
    "watch": "tsc -w",
    "check": "npx tsc --noEmit",
    "test": "jest",
    "test:unit": "jest test/unit",
    "test:validation": "jest test/validation",
    "test:compliance": "jest test/compliance",
    "test:snapshot": "jest test/snapshot",
    "test:snapshot:update": "jest test/snapshot --updateSnapshot",
    "synth": "cross-env COMMIT_HASH=$(git rev-parse --short HEAD) cdk synth '**' -c project=${PROJECT} -c env=${ENV} --profile ${PROJECT}-${ENV}",
    "diff": "cross-env COMMIT_HASH=$(git rev-parse --short HEAD) cdk diff '**' -c project=${PROJECT} -c env=${ENV} --profile ${PROJECT}-${ENV}",
    "stage:deploy:all": "cross-env COMMIT_HASH=$(git rev-parse --short HEAD) cdk deploy '**' -c project=${PROJECT} -c env=${ENV} --profile ${PROJECT}-${ENV}",
    "stage:destroy:all": "cross-env cdk destroy '**' -c project=${PROJECT} -c env=${ENV} --profile ${PROJECT}-${ENV}",
    "bootstrap": "cross-env cdk bootstrap -c project=${PROJECT} -c env=${ENV} --profile ${PROJECT}-${ENV}",
    "lint": "eslint \"**/*.ts\"",
    "lint:fix": "eslint \"**/*.ts\" --fix",
    "format": "prettier --write \"**/*.ts\"",
    "docs": "npx typedoc",
    "clean": "rimraf ./cdk.out ./dist ./node_modules/.cache",
    "prepare": "husky"
  }
}
```

実行例:

```bash
PROJECT=myapp ENV=dev npm run synth
PROJECT=myapp ENV=dev npm run stage:deploy:all
```

---

## 10. AWS 認証設定（.aws/config）

### IAM Identity Center（SSO）

```ini
[sso-session mysso]
sso_start_url = https://d-xxxxxxxxxx.awsapps.com/start/
sso_region = ap-northeast-1
sso_registration_scopes = sso:account:access

[profile myapp-dev]
sso_session = mysso
sso_account_id = 222222222222
sso_role_name = AdministratorAccess
region = ap-northeast-1

[profile myapp-prod]
sso_session = mysso
sso_account_id = 111111111111
sso_role_name = AdministratorAccess
region = ap-northeast-1
```

```bash
aws sso login --profile myapp-dev
aws sts get-caller-identity --profile myapp-dev
```

### CDK Bootstrap（初回のみ）

```bash
cd infra
PROJECT=myapp ENV=dev npm run bootstrap
```

---

## 11. .gitignore

```gitignore
*.js
!jest.config.js
*.d.ts
node_modules

# CDK
.cdk.staging
cdk.out

# TypeDoc
docs/reference
```

---

## 12. セットアップ確認チェックリスト

```bash
# 1. 依存パッケージ
cd infra && npm install

# 2. TypeScript コンパイル
npx tsc --noEmit

# 3. ESLint
npm run lint

# 4. テスト
npm test

# 5. CDK synth
PROJECT=myapp ENV=dev npm run synth

# 6. TypeDoc
npm run docs
```

全コマンドがエラーなしで完了すれば開発環境セットアップ完了。
