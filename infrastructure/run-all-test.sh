#!/bin/bash
SCRIPT_DIR=$(cd "$(dirname "$0")" ; pwd)/
# Display Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

errorWorkspaces=()

cd "$SCRIPT_DIR"

for workspace_dir in "${SCRIPT_DIR}workspaces/"*/; do
    workspace_name=$(basename "$workspace_dir")
    echo -e "${YELLOW}Running tests for workspace: $workspace_name${NC}"
    PROJECT=drillexercises ENV=dev npm run test -w workspaces/$workspace_name
    return_code=$?

    if [ $return_code -ne 0 ]; then
        echo -e "${RED}❌ Tests failed for workspace: $workspace_name with return code: $return_code${NC}"
        errorWorkspaces+=("$workspace_name")
    else
        echo -e "${GREEN}✅ Tests succeeded for workspace: $workspace_name${NC}"
    fi
done

if [ ${#errorWorkspaces[@]} -ne 0 ]; then
    echo -e "${RED}❌ Tests failed for the following workspaces: ${errorWorkspaces[*]}${NC}"
    exit 1
fi

echo -e "${GREEN}✅ All tests passed successfully for all workspaces.${NC}"
exit 0