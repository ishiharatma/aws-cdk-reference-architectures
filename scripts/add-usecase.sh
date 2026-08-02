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

# Initialize new CDK app
cdk init app --language typescript

# Remove aws-cdk from this workspace's devDependencies.
# It is already managed as a devDependency at the workspaces root
# (infrastructure/package.json) and hoisted via npm workspaces,
# so keeping it here would only cause version drift between workspaces.
npm pkg delete devDependencies.aws-cdk

# Create directory structure
mkdir -p lib/{aspects,constructs,stacks,stages,types}
#mkdir -p test/{snapshot,unit,integration,validation,compliance}
#touch test/snapshot/snapshot.test.ts
mkdir -p parameters src

# Copy templates/init-workspace files 
cp -r ${PARENT_DIR}/templates/init-workspace/. ${workspacesDir}/

mv lib/${workspaces_name}-stack.ts lib/stacks/
mv test/${workspaces_name}.test.ts test/unit/

# Add necessary scripts to the main package.json
cd ${SCRIPT_DIR}
node ./add-scripts.js infrastructure/workspaces/${workspaces_name}

echo "Usecase '${workspaces_name}' has been created successfully."
echo "Next steps:"
echo "Please update the project name in cdk.json appropriately."
echo "Edit README.md and README.ja.md as needed."

exit 0