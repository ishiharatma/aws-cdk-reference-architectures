#!/bin/bash
#set -ex
set -e

#cd /workspaces/${localWorkspaceFolderBasename}/infrastructure/cdk-workspaces
#test -f package.json && npm install || echo 'No package.json found, skipping npm install'

# Add node user to docker group
#sudo usermod -aG docker node
# Adjust permissions for Docker socket
#sudo chmod 666 /var/run/docker.sock

git config --global core.autocrlf false
git config --global core.filemode false

# AWS SSO login and get-caller-identity alias setup
# Basic commands (for default profile)
echo 'alias awslogin="aws login && echo \"Current credentials:\" && aws sts get-caller-identity"' >> ~/.bashrc
echo 'alias awsid="aws sts get-caller-identity"' >> ~/.bashrc

echo 'alias ssologin="aws sso login && echo \"Current credentials:\" && aws sts get-caller-identity"' >> ~/.bashrc

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
  aws login --profile "$1" && echo "Current credentials ($1):" && aws sts get-caller-identity --profile "$1"
}

ssologinp() {
  if [ -z "$1" ]; then
    echo "Usage: ssologinp <profile-name>"
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

# Switch role and save config
swrole() {
  if [ -z "$1" ] || [ -z "$2" ] || [ -z "$3" ]; then
    echo "Usage: swrole <accountId> <role-arn> <profile-name> [source-profile] [region] [MFA-name]"
    echo "Example: swrole 123456789012 @role-admin my-admin-role awslogin ap-northeast-1 my-mfa"
    return 1
  fi
  
  local account_id="$1"
  local role_name="$2"
  local profile_name="$3"
  local source_profile="${4:-awslogin}"
  local region="${5:-ap-northeast-1}"
  local mfa_name="${6:-}"

  local role_arn="arn:aws:iam::${account_id}:role/${role_name}"
  
  echo "Account ID: $account_id"
  echo "Assuming role: $role_arn"
  echo "Source profile: $source_profile"
  echo "Target profile: $profile_name"
  echo "Region: $region"
  
  # Create or update credentials file
  local config_file="$HOME/.aws/config"
  touch "$config_file"
  
  # Remove existing profile if it exists
  if grep -q "^\[$profile_name\]" "$config_file"; then
    echo "Updating existing profile: $profile_name"
    # Create temp file without the target profile
    awk -v profile="$profile_name" '\''
      BEGIN { skip=0 }
      /^\[/ { skip=0 }
      $0 == "[profile "profile"]" { skip=1; next }
      skip == 0 { print }
    '\'' "$config_file" > "${config_file}.tmp"
    mv "${config_file}.tmp" "$config_file"
  else
    echo "Creating new profile: $profile_name"
  fi
  
  # Ensure file ends with newline, then append new config
  [ -s "$config_file" ] && [ -z "$(tail -c 1 "$config_file")" ] || echo "" >> "$config_file"
  
  {
    echo "[profile $profile_name]"
    echo "role_arn = $role_arn"
    if [ -n "$mfa_name" ]; then
      echo "mfa_serial = arn:aws:iam::${account_id}:mfa/${mfa_name}"
    fi
    echo "source_profile = $source_profile"
    echo "account = $account_id"
    echo "region = $region"
  } >> "$config_file"

  echo "✅ Config saved to profile: $profile_name"
  echo ""
  echo "Testing config..."
  aws sts get-caller-identity --profile "$profile_name"
  
  if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Profile is ready to use!"
    echo "Example: aws s3 ls --profile $profile_name"
  fi
}

# Switch role and save credentials
swcre() {
  if [ -z "$1" ] || [ -z "$2" ]; then
    echo "Usage: swcre <role-arn> <profile-name> [source-profile] [session-name]"
    echo "Example: swcre arn:aws:iam::123456789012:role/@role-admin my-admin-role awslogin my-session"
    return 1
  fi
  
  local role_arn="$1"
  local profile_name="$2"
  local source_profile="${3:-awslogin}"
  local session_name="${4:-${profile_name}-session}"
  
  echo "Assuming role: $role_arn"
  echo "Source profile: $source_profile"
  echo "Target profile: $profile_name"
  echo "Session name: $session_name"
  
  # Assume role and get credentials
  local assume_output
  assume_output=$(aws sts assume-role --role-arn "$role_arn" --role-session-name "$session_name" --profile "$source_profile" 2>&1)
  
  if [ $? -ne 0 ]; then
    echo "Error: Failed to assume role"
    echo "$assume_output"
    return 1
  fi
  
  # Parse JSON output
  local access_key
  local secret_key
  local session_token
  
  access_key=$(echo "$assume_output" | grep -o "\"AccessKeyId\": \"[^\"]*\"" | cut -d"\"" -f4)
  secret_key=$(echo "$assume_output" | grep -o "\"SecretAccessKey\": \"[^\"]*\"" | cut -d"\"" -f4)
  session_token=$(echo "$assume_output" | grep -o "\"SessionToken\": \"[^\"]*\"" | cut -d"\"" -f4)
  
  if [ -z "$access_key" ] || [ -z "$secret_key" ] || [ -z "$session_token" ]; then
    echo "Error: Failed to parse credentials"
    return 1
  fi
  
  # Create or update credentials file
  local cred_file="$HOME/.aws/credentials"
  touch "$cred_file"
  
  # Remove existing profile if it exists
  if grep -q "^\[$profile_name\]" "$cred_file"; then
    echo "Updating existing profile: $profile_name"
    # Create temp file without the target profile
    awk -v profile="$profile_name" '\''
      BEGIN { skip=0 }
      /^\[/ { skip=0 }
      $0 == "["profile"]" { skip=1; next }
      skip == 0 { print }
    '\'' "$cred_file" > "${cred_file}.tmp"
    mv "${cred_file}.tmp" "$cred_file"
  else
    echo "Creating new profile: $profile_name"
  fi
  
  # Ensure file ends with newline, then append new credentials
  [ -s "$cred_file" ] && [ -z "$(tail -c 1 "$cred_file")" ] || echo "" >> "$cred_file"
  
  {
    echo "[$profile_name]"
    echo "aws_access_key_id = $access_key"
    echo "aws_secret_access_key = $secret_key"
    echo "aws_session_token = $session_token"
  } >> "$cred_file"
  
  echo "✅ Credentials saved to profile: $profile_name"
  echo ""
  echo "Testing credentials..."
  aws sts get-caller-identity --profile "$profile_name"
  
  if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Profile is ready to use!"
    echo "Example: aws s3 ls --profile $profile_name"
  fi
}

# Clear assumed role credentials from profile
clearrole() {
  if [ -z "$1" ]; then
    echo "Usage: clearrole <profile-name>"
    echo "Example: clearrole my-admin-role"
    return 1
  fi
  
  local profile_name="$1"
  local cred_file="$HOME/.aws/credentials"
  
  if [ ! -f "$cred_file" ]; then
    echo "Error: Credentials file not found: $cred_file"
    return 1
  fi
  
  if ! grep -q "^\[$profile_name\]" "$cred_file"; then
    echo "Error: Profile not found: $profile_name"
    return 1
  fi
  
  echo "Removing profile: $profile_name"
  
  # Remove the profile
  awk -v profile="$profile_name" '\''
    BEGIN { skip=0 }
    /^\[/ { skip=0 }
    $0 == "["profile"]" { skip=1; next }
    skip == 0 { print }
  '\'' "$cred_file" > "${cred_file}.tmp"
  mv "${cred_file}.tmp" "$cred_file"
  
  echo "✅ Profile removed: $profile_name"
}

# AWS logout and optionally clear credentials
awslogout() {
  local profile_name="${1:-awslogin}"
  
  echo "Logging out from profile: $profile_name"
  aws logout --profile "$profile_name"
  
  if [ $? -eq 0 ]; then
    echo ""
    echo "Checking if profile exists in credentials..."
    if grep -q "^\[$profile_name\]" "$HOME/.aws/credentials" 2>/dev/null; then
      echo "Removing profile from credentials file..."
      clearrole "$profile_name"
    else
      echo "✅ Logout complete (no credentials to remove)"
    fi
  else
    echo "Warning: Logout command failed, but will still attempt to remove credentials if they exist"
    if grep -q "^\[$profile_name\]" "$HOME/.aws/credentials" 2>/dev/null; then
      clearrole "$profile_name"
    fi
  fi
}

# Function to display alias tips
tips() {
  echo "-----------------------------------"
  echo "Useful Command Tips"
  echo "-----------------------------------"
  echo "AWS related:"
  echo "  awslogin: AWS login + check current credentials (default profile)"
  echo "  awsloginp <profile-name>: AWS login with specified profile + check credentials"
  echo "  awslogout [profile-name]: AWS logout and remove credentials (default: awslogin)"
  echo "  ssologin: AWS SSO login + check current credentials (default profile)"
  echo "  ssologinp <profile-name>: AWS SSO login with specified profile + check credentials"
  echo "  awsid: Check credentials only (default profile)"
  echo "  awsidp <profile-name>: Check credentials only for specified profile"
  echo ""
  echo "Role switching:"
  echo "  swrole <role-arn> <profile-name> [source-profile] [session-name]"
  echo "    Example: swrole arn:aws:iam::123456789012:role/@role-admin my-admin awslogin"
  echo "    Assumes a role and saves temporary credentials to specified profile"
  echo "  clearrole <profile-name>: Remove assumed role credentials from profile"
  echo "    Example: clearrole my-admin"
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
  echo "  awslogout            : Logout from awslogin profile"
  echo "  awslogout my-admin   : Logout from my-admin profile"
  echo "  swrole arn:aws:iam::123456789012:role/@role-admin my-admin-role"
  echo "    : Assume role and save to my-admin-role profile"
  echo "  aws s3 ls --profile my-admin-role"
  echo "    : Use assumed role credentials"
  echo "  clearrole my-admin-role : Remove my-admin-role from credentials"
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
# Check Kiro CLI configuration
if command -v kiro-cli &> /dev/null; then
    echo "✅ Kiro CLI is available"
    echo "Kiro CLI version: $(kiro-cli version || echo "Version check failed but CLI is installed")"
else
    echo "❌ Kiro CLI not found"
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