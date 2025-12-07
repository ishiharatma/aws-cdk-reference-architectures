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
cdkDir=${PARENT_DIR}/infrastructure/cdk-workspaces
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

# Create directory structure
mkdir -p lib/{aspects,constructs,stacks,stages,types}
#mkdir -p test/{snapshot,unit,integration,validation,compliance}
#touch test/snapshot/snapshot.test.ts
mkdir -p parameters src

# Copy templates/init-workspace files 
cp -r ${PARENT_DIR}/templates/init-workspace/. ${workspacesDir}/

mv ${workspaces_name}.ts stacks/
mv ${workspaces_name}.test.ts test/unit/

# Add necessary scripts to the main package.json
cd ${SCRIPT_DIR}
node ./add-scripts.js infrastructure/cdk-workspaces/workspaces/${workspaces_name}

echo "Usecase '${workspaces_name}' has been created successfully."
echo "Next steps:"
echo "Please update the project name in cdk.json appropriately."
echo "Edit README.md and README.ja.md as needed."

exit 0