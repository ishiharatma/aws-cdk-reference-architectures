import * as fs from "fs";
import * as path from "path";

// CDK contextファイルを読み込む関数
export function loadCdkContext(): Record<string, unknown> {
  try {
    const cdkJsonPath = path.resolve(__dirname, "../../cdk.json");
    const cdkJsonContent = fs.readFileSync(cdkJsonPath, "utf8");
    return JSON.parse(cdkJsonContent) as Record<string, unknown>;
  } catch (error) {
    console.error("Failed to load cdk.json:", error);
    return {};
  }
}

// デフォルトエクスポートとしても提供
export const baseContext = loadCdkContext();
export default baseContext;
