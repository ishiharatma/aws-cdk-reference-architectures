#!/bin/bash
#set -ex
set -e

#cd /workspaces/${localWorkspaceFolderBasename}/infra
#test -f package.json && npm install || echo 'No package.json found, skipping npm install'

# Add node user to docker group
#sudo usermod -aG docker node
# Adjust permissions for Docker socket
#sudo chmod 666 /var/run/docker.sock

git config --global core.autocrlf false
git config --global core.filemode false

# AWS SSO login and get-caller-identity alias setup
# Basic commands (for default profile)
echo 'alias awslogin="aws sso login && echo \"Current credentials:\" && aws sts get-caller-identity"' >> ~/.bashrc
#echo 'alias awslogin="aws sso login && echo \"Current credentials:\" && aws sts get-caller-identity"' >> ~/.zshrc
echo 'alias awsid="aws sts get-caller-identity"' >> ~/.bashrc
#echo 'alias awsid="aws sts get-caller-identity"' >> ~/.zshrc

# NPM-related alias
echo 'alias npmfl="npm run format && npm run lint:fix"' >> ~/.bashrc

# CDK-related alias
echo 'alias cdksynth="npm run cdk synth"' >> ~/.bashrc

# Other alias
echo '
# AWS SSO login function with profile option
awsloginp() {
  if [ -z "$1" ]; then
    echo "Usage: awsloginp <profile-name>"
    return 1
  fi
  aws sso login --profile "$1" && echo "Current credentials ($1):" && aws sts get-caller-identity --profile "$1"
}

# AWS credentials check function with profile option
awsidp() {
  if [ -z "$1" ]; then
    echo "Usage: awsidp <profile-name>"
    return 1
  fi
  aws sts get-caller-identity --profile "$1"
}

# Function to display alias tips
tips() {
  echo "-----------------------------------"
  echo "Useful Command Tips"
  echo "-----------------------------------"
  echo "AWS related:"
  echo "  awslogin: AWS SSO login + check current credentials (default profile)"
  echo "  awsid: Check credentials only (default profile)"
  echo "  awsloginp <profile-name>: AWS SSO login with specified profile + check credentials"
  echo "  awsidp <profile-name>: Check credentials only for specified profile"
  echo ""
  echo "NPM related:"
  echo "  npmfl: Run linter and formatter (npm run format && npm run lint:fix)"
  echo "CDK related:"
  echo "  cdksynth: Generate CloudFormation template (npm run cdk synth)"
  echo ""
  echo "Other:"
  echo "  tips: Display this help message"
  echo "-----------------------------------"
  echo "Examples:"
  echo "  awslogin             : Login with default profile"
  echo "  awsloginp dev-admin  : Login with dev profile"
  echo "  npmfl                : Run linter and formatter"
  echo "-----------------------------------"
}
' >> ~/.bashrc

# Reflect changes in current shell
#source ~/.bashrc 2>/dev/null || source ~/.zshrc 2>/dev/null
source ~/.bashrc 2>/dev/null

echo "=== Post-create setup starting ==="

echo "-----------------------------------"
echo "Checking versions..."
echo "-----------------------------------"
if command -v node &> /dev/null; then
    echo "✅ Node is available"
    echo "node version: $(node -v)"
else
    echo "❌ Node not found"
fi
if command -v npm &> /dev/null; then
    echo "✅ NPM is available"
    echo "npm version: $(npm -v)"
else
    echo "❌ NPM not found"
fi
# Check Git configuration
if command -v git &> /dev/null; then
    echo "✅ Git is available"
    echo "Git version: $(git --version)"
else
    echo "❌ Git not found"
fi

# Check AWS CLI configuration
if command -v aws &> /dev/null; then
    echo "✅ AWS CLI is available"
    echo "AWS CLI version: $(aws --version)"
    echo "aws session manager plugin version: $(session-manager-plugin --version)"
else
    echo "❌ AWS CLI not found"
fi

# Check AWS CDK configuration
if command -v cdk &> /dev/null; then
    echo "✅ AWS CDK is available"
    echo "AWS CDK version: $(cdk --version)"
else
    echo "❌ AWS CDK not found"
fi
# Check LocalStack configuration
if command -v localstack &> /dev/null; then
    echo "✅ LocalStack is available"
    echo "LocalStack version: $(localstack --version)"
else
    echo "❌ LocalStack not found"
fi

# Check Python configuration
if command -v python3 &> /dev/null; then
    echo "✅ Python3 is available"
    echo "Python version:"
    python3 --version
else
    echo "❌ Python3 not found"
fi
if command -v pip3 &> /dev/null; then
    echo "✅ pip3 is available"
    echo "Pip version: $(pip3 --version)"
else
    echo "❌ pip3 not found"
fi

# Check UV, UVX configuration
if command -v uv &> /dev/null; then
    echo "✅ UV is available"
    echo "UV version: $(uv --version)"
else
    echo "❌ UV not found"
fi
if command -v uvx &> /dev/null; then
    echo "✅ UVX is available"
    echo "UVX version: $(uvx --version)"
else
    echo "❌ UVX not found"
fi

# Check Graphviz configuration
if command -v dot &> /dev/null; then
    echo "✅ Graphviz is available"
    echo "Graphviz version: $(dot -V)"
else
    echo "❌ Graphviz not found"
fi

# Check Amazon Q CLI configuration
if command -v q &> /dev/null; then
    echo "✅ Amazon Q CLI is available"
    echo "Amazon Q CLI version: $(q --version || echo "Version check failed but CLI is installed")"
else
    echo "❌ Amazon Q CLI not found"
fi

echo "-----------------------------------"
echo "Checking AWS configuration..."
echo "-----------------------------------"

echo "## aws configure list"
# If you get an error like "Error when retrieving token from sso: Token has expired and refresh failed",
# the return value may not be normal, so we add echo "" here.
# In that case, you need to run aws sso login <profile> to refresh the token.
aws configure list || echo ""

echo "## aws configure list-profiles"
aws configure list-profiles || echo ""

# Initial tips display
echo "Run the 'tips' command to see registered helpful command aliases"

echo "=== Post-create setup completed ==="
echo "You can now use:"
echo "  - q --help          (Amazon Q CLI)"
echo "  - aws --help        (AWS CLI)"
echo "  - python3 --help (Python)"
echo "  - cdk --help     (AWS CDK)"
echo "  - localstack --help (LocalStack)"
echo "Type 'tips' to see useful command aliases and functions."