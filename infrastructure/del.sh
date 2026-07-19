#!/bin/sh
# Delete the CDK stack for the workspaces
# Usage: del.sh --workspace-name <workspace-name>
set -e
SCRIPT_DIR=$(cd $(dirname $0) ; pwd)/
# Display Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

workspace_name=""

while [ "$1" != "" ]; do
    case $1 in
        --workspace-name )   shift
                            workspace_name=$1
                            ;;
        * )                 echo -e "${RED}Invalid option: $1${NC}"
                            exit 1
    esac
    shift
done

echo "${YELLOW}Deleting CDK stack for workspace: $workspace_name${NC}"

# Check if workspace name is provided and not empty
if [ -z "$workspace_name" ]; then
    echo "${RED}Error: --workspace-name parameter is required.${NC}"
    exit 1
fi
if [ ! -d "${SCRIPT_DIR}/workspaces/${workspace_name}" ]; then
    echo "${RED}Error: Workspace '${workspace_name}' does not exist.${NC}"
    exit 1
fi

# Execution confirmation
printf "${BLUE}Are you sure you want to delete the workspace '${workspace_name}'?${NC} (y/n): "
read -r confirmation
if [ "$confirmation" != "y" ]; then
    echo "${YELLOW}Deletion cancelled by user.${NC}"
    exit 0
fi

PROJECT=drillexercises ENV=dev npm run delstack -w workspaces/$workspace_name
return_code=$?

if [ $return_code -ne 0 ]; then
    echo "${RED}❌ Deletion failed with return code: $return_code${NC}"
    exit $return_code
else
    echo "${GREEN}✅ Deletion succeeded for workspace: $workspace_name${NC}"
fi

exit 0