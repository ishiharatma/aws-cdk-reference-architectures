# ---------------------------------------------------------------------------
# Copies the DCV Group Policy templates (wsp.admx / wsp.adml) from a running WorkSpace into the
# domain's Central Store, so the DCV settings of GPO-WS-Security can be edited in GPMC.
# Run once after the first WorkSpace is AVAILABLE (runs as LocalSystem via Run Command).
#
# Reaching the WorkSpace uses WinRM (TCP 5985), which GPO-WS-Audit opens for the management
# subnets and the WorkSpaces security group allows from them.
#
# Variables injected by the document header:
#   $WorkSpaceComputerName, $DomainName, $AdminSecretArn, $Region, $NetBiosName
# ---------------------------------------------------------------------------
$password = Get-AdminPassword
$credential = Get-AdminCredential -Password $password

$staging = Join-Path $env:ProgramData 'WorkSpacesAdBootstrap\wsp-admx'
New-Item -ItemType Directory -Path $staging -Force | Out-Null

$session = New-PSSession -ComputerName $WorkSpaceComputerName -Credential $credential
try {
    Copy-Item -FromSession $session -Path 'C:\Program Files\Amazon\WSP\wsp.admx' -Destination $staging -Force
    Copy-Item -FromSession $session -Path 'C:\Program Files\Amazon\WSP\wsp.adml' -Destination $staging -Force
} finally {
    Remove-PSSession -Session $session
}

New-PSDrive -Name WsSysvol -PSProvider FileSystem -Root "\\$DomainName\SYSVOL" -Credential $credential | Out-Null
try {
    $central = "WsSysvol:\$DomainName\Policies\PolicyDefinitions"
    if (-not (Test-Path $central)) {
        # Once a Central Store exists GPMC reads templates only from it, so seed it with the
        # templates of this Windows Server 2025 instance first.
        Copy-Item -Path "$env:windir\PolicyDefinitions" -Destination "WsSysvol:\$DomainName\Policies" -Recurse
        Write-Output 'Created the Central Store from the local PolicyDefinitions'
    }
    New-Item -ItemType Directory -Path "$central\en-US" -Force | Out-Null
    Copy-Item -Path (Join-Path $staging 'wsp.admx') -Destination $central -Force
    Copy-Item -Path (Join-Path $staging 'wsp.adml') -Destination "$central\en-US" -Force
    Write-Output "Installed wsp.admx / wsp.adml into $central"
} finally {
    Remove-PSDrive -Name WsSysvol
}
