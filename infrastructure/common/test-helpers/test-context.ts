import * as fs from "fs";

// Function to load CDK context file
export function loadCdkContext(cdkJsonPath: string): Record<string, unknown> {
  try {
    const cdkJsonContent = fs.readFileSync(cdkJsonPath, "utf8");
    return JSON.parse(cdkJsonContent) as Record<string, unknown>;
  } catch (error) {
    console.error("Failed to load cdk.json:", error);
    return {};
  }
}