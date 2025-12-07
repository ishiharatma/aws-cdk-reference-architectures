#!/bin/bash
# filepath: init-cdk.sh
# Usage: ./init-cdk.sh [optional-cdk-directory]
# Example:
#   ./init-cdk.sh (initialize in default infrastructure/cdk)
#   ./init-cdk.sh infrastructure/cdk-workspaces (initialize in specified directory)
# Description: Initialize a new CDK project
SCRIPT_DIR=$(cd $(dirname $0) ; pwd)/
PARENT_DIR=$(cd ${SCRIPT_DIR}/.. ; pwd)
targetDir=infrastructure/cdk

if [ -z "$1" ]; then
    echo "Initializing CDK project in default 'infrastructure/cdk' directory."
else
    targetDir=$1
    echo "Initializing CDK project in specified directory: ${targetDir}"
fi

cdkDir=${PARENT_DIR}/${targetDir}

if [ -d "${cdkDir}" ]; then
    echo "CDK directory already exists. Initialization skipped."
    #exit 0
	cd ${cdkDir}
else
    mkdir -p ${cdkDir}
	# Create Common directory
	mkdir -p ${cdkDir}/common

	# Create workspaces directory
	workspacesDir=${cdkDir}/workspaces
	mkdir -p ${workspacesDir}

	cd ${cdkDir}

	# Initialize npm project
	npm init -y
fi
# Add necessary scripts to package.json
node ${SCRIPT_DIR}/init-cdk-scripts.js ${targetDir}

# Install necessary dev dependencies
npm install --save-dev eslint \
	eslint eslint-cdk-plugin \
	eslint-config-prettier \
	eslint-plugin-prettier \
	eslint-plugin-unused-imports \
	@eslint/js \
	prettier \
	husky \
	lint-staged \
	rimraf \
	typescript-eslint \
	@typescript-eslint/eslint-plugin \
	@typescript-eslint/parser \
	cdk-nag \
	cross-env \
	@aws-cdk/aws-lambda-python-alpha

npm install tsconfig-paths \
	change-case-commonjs

# Initialize TypeScript configuration
npx tsc --init

# Copy templates/init-cdk 
cp -r ${PARENT_DIR}/templates/init-cdk/. ${cdkDir}/

# 
npx husky install
npx husky add .husky/pre-commit "npx lint-staged"

echo "CDK Project has been created successfully."
echo "Next steps:"
echo "Please update the project name in cdk.json appropriately."
echo "Edit README.md and README.ja.md as needed."

exit 0