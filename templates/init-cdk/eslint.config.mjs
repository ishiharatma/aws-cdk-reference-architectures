import pluginJs from "@eslint/js";
import prettierConfig from "eslint-config-prettier";
import unusedImportPlugin from "eslint-plugin-unused-imports";
import eslintCdkPlugin from "eslint-cdk-plugin";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    files: ["**/*.ts"],
  },
  {
    ignores: ["**/node_modules/**/*", "**/cdk.out/**/*", "**/*.js", "**/*.d.ts", "eslint.config.mjs"],
  },
  {
    languageOptions: {
      sourceType: "script",
      parserOptions: {
        project: "./tsconfig.json",
        projectService: true,
      }
    },
  },
  pluginJs.configs.recommended,
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,
  {
    plugins: {
      "unused-imports": unusedImportPlugin,
      cdk: eslintCdkPlugin,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "off", // 重複エラーを防ぐため typescript-eslint の方を無効化
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "error",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],
      ...eslintCdkPlugin.configs.recommended.rules,
      "cdk/no-variable-construct-id": "off",
    },
  },
  prettierConfig // フォーマット は Prettier で行うため、フォーマット関連のルールを無効化
);
