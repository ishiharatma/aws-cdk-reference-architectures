# ---------------------------------------------------------------------------
# Shared helpers for the SSM Run Command documents of this workspace.
# Expects $AdminSecretArn, $Region and $NetBiosName to be defined by the caller.
# ---------------------------------------------------------------------------
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Get-AdminPassword {
    # AWS Tools for PowerShell ship with the AWS Windows AMIs; fall back to the AWS CLI.
    if (Get-Command -Name Get-SECSecretValue -ErrorAction SilentlyContinue) {
        return (Get-SECSecretValue -SecretId $AdminSecretArn -Region $Region).SecretString
    }
    $json = & aws secretsmanager get-secret-value --secret-id $AdminSecretArn --region $Region --output json
    if ($LASTEXITCODE -ne 0) {
        throw 'Failed to read the AD admin secret from Secrets Manager'
    }
    return ($json | ConvertFrom-Json).SecretString
}

function Get-AdminCredential {
    param([Parameter(Mandatory)] [string]$Password)
    $secure = ConvertTo-SecureString -String $Password -AsPlainText -Force
    return New-Object System.Management.Automation.PSCredential("$NetBiosName\Admin", $secure)
}
