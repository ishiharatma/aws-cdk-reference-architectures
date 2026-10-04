#!/bin/bash
# filepath: add-usecase.sh

# Usage: ./add-usecase.sh my-usecase
# Description: Initialize a new CDK usecase project with the specified name
SCRIPT_DIR=$(cd $(dirname $0) ; pwd)/
PARENT_DIR=$(cd ${SCRIPT_DIR}/.. ; pwd)

if [ -z "$1" ]; then
    echo "Error: workspaces_name parameter is required."
    exit 1
fi

workspaces_name=$1
cdkDir=${PARENT_DIR}/infrastructure
workspacesDir=${cdkDir}/workspaces/${workspaces_name}

# Check if workspaces directory already exists
if [ -d "${workspacesDir}" ]; then
    echo "Usecase directory '${workspaces_name}' already exists. Creation skipped."
    exit 0
fi

mkdir -p ${workspacesDir}
cd ${workspacesDir}

# Initialize new CDK app.
# --generate-only skips `npm install`: inside this monorepo that install resolved the latest majors
# (TypeScript 7, Jest 30) and wrote them into the root package-lock.json, which then kept stale entries
# even after node_modules was removed. Dependencies are installed once, at the root, at the end of this script.
cdk init app --language typescript --generate-only

# Remove aws-cdk from this workspace's devDependencies.
# It is already managed as a devDependency at the workspaces root
# (infrastructure/package.json) and hoisted via npm workspaces,
# so keeping it here would only cause version drift between workspaces.
npm pkg delete devDependencies.aws-cdk

# Pin the test/type toolchain. `cdk init` installs the latest majors (TypeScript 7, Jest 30, @swc/jest),
# but this repository's tooling supports TypeScript < 6.1 only: typescript-eslint and eslint-plugin-awscdk
# declare that peer range, and ts-jest (used by templates/init-workspace/jest.config.js) needs the
# TypeScript JS compiler API, which TypeScript 7 does not expose.
npm pkg set "devDependencies.typescript=~6.0.3" "devDependencies.jest=^29.7.0" \
    "devDependencies.ts-jest=^29.2.5" "devDependencies.@types/jest=^29.5.14"
npm pkg delete devDependencies.@swc/core devDependencies.@swc/jest

rm -rf node_modules package-lock.json

# `cdk init` runs the app through `npx tsc && npx tsx`. tsc would emit .js files next to the sources, and tsx
# then loads `parameters/environments` and `parameters` as two different module copies, so the registered
# environment parameters are lost ("No parameters found for environment"). tsx alone is enough.
sed -i 's#"app": "npx tsc && npx tsx#"app": "npx tsx#' cdk.json

# Create directory structure
mkdir -p lib/{aspects,constructs,stacks,stages,types}
#mkdir -p test/{snapshot,unit,integration,validation,compliance}
#touch test/snapshot/snapshot.test.ts
mkdir -p parameters src

# Copy templates/init-workspace files 
cp -r ${PARENT_DIR}/templates/init-workspace/. ${workspacesDir}/

mv lib/${workspaces_name}-stack.ts lib/stacks/
mv test/${workspaces_name}.test.ts test/unit/

# get Stack class name from the app file
StackClassName=$(grep -oP 'new \K\w+(?=\()' bin/${workspaces_name}.ts)
StackBaseName=$(echo ${StackClassName} | sed 's/Stack$//')

mv bin/template-app.ts bin/${workspaces_name}.ts
mv lib/stages/template-stage.ts lib/stages/${workspaces_name}-stage.ts

# Rename the stack class in the stack file
sed -i "s/TemplateStage/${StackBaseName}Stage/g" lib/stages/${workspaces_name}-stage.ts
# Rename the stage class in the app file
sed -i "s/TemplateStage/${StackBaseName}Stage/g" bin/${workspaces_name}.ts
sed -i "s/template-stage/${workspaces_name}-stage/g" bin/${workspaces_name}.ts
sed -i "s/Template/${StackBaseName}/g" bin/${workspaces_name}.ts
# Replace the stack class name in the stage file
sed -i "s/template-stack/${workspaces_name}-stack/g" lib/stages/${workspaces_name}-stage.ts
sed -i "s/TemplateStack/${StackBaseName}Stack/g" lib/stages/${workspaces_name}-stage.ts
sed -i "s/Template/${StackBaseName}/g" lib/stages/${workspaces_name}-stage.ts

# Add necessary scripts to the main package.json
cd ${SCRIPT_DIR}
node ./add-scripts.js infrastructure/workspaces/${workspaces_name}

# Sync the root package-lock.json with the new workspace; CI runs `npm ci`, which fails on a stale lock file.
cd ${cdkDir}
npm install --package-lock-only

echo "Usecase '${workspaces_name}' has been created successfully."
echo "Next steps:"
echo "Please update the project name in cdk.json appropriately."
echo "Edit README.md and README.ja.md as needed."

exit 0