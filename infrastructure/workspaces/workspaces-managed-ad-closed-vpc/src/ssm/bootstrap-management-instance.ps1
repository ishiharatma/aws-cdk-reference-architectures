# ---------------------------------------------------------------------------
# Bootstrap of the management instance (runs as LocalSystem via a State Manager association).
#
# Phase 1 (not yet domain-joined):
#   point DNS at the domain controllers, install RSAT / GPMC, create the OU the instance joins
#   into (OU=Admin) remotely with the admin credential, join the domain and exit 3010 so that
#   SSM reboots the instance and runs this script again.
# Phase 2 (domain-joined):
#   run Build-AdObjects.ps1 as the domain admin through a one-shot scheduled task. The
#   GroupPolicy cmdlets have no -Credential parameter and LocalSystem (the computer account)
#   has no rights on GPOs, so the work must run in a real logon session of the admin.
#
# Variables injected by the document header:
#   $ConfigBase64, $DnsIpAddresses, $AdminSecretArn, $Region, $Stage2Base64, $NetBiosName
# ---------------------------------------------------------------------------
$Config = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ConfigBase64)) | ConvertFrom-Json
$DnsIps = @($DnsIpAddresses.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
$WorkDir = 'C:\ProgramData\WorkSpacesAdBootstrap'
New-Item -ItemType Directory -Path $WorkDir -Force | Out-Null

$password = Get-AdminPassword
$credential = Get-AdminCredential -Password $password

Install-WindowsFeature -Name RSAT-AD-PowerShell, RSAT-ADDS-Tools, GPMC | Out-Null
Import-Module ActiveDirectory

$domainDn = ($Config.domainName.Split('.') | ForEach-Object { "DC=$_" }) -join ','
$baseDn = "OU=$($Config.netBiosName),$domainDn"

if (-not (Get-CimInstance -ClassName Win32_ComputerSystem).PartOfDomain) {
    # ----------------------------- Phase 1 -----------------------------
    $adapter = Get-NetAdapter | Where-Object Status -eq 'Up' | Sort-Object ifIndex | Select-Object -First 1
    Set-DnsClientServerAddress -InterfaceIndex $adapter.ifIndex -ServerAddresses $DnsIps
    Write-Output "DNS servers set to $($DnsIps -join ', ')"

    # Create the join target OU chain first so the computer object lands in OU=Admin directly
    # (and therefore receives GPO-Admin from its first boot in the domain).
    $parentDn = $baseDn
    foreach ($rdn in ($Config.managementComputerOu.Split(',') | ForEach-Object { $_.Trim() })[-1..0]) {
        $name = $rdn -replace '^OU=', ''
        $dn = "$rdn,$parentDn"
        $existing = Get-ADOrganizationalUnit -Filter "DistinguishedName -eq '$dn'" -Server $DnsIps[0] -Credential $credential
        if (-not $existing) {
            New-ADOrganizationalUnit -Name $name -Path $parentDn -ProtectedFromAccidentalDeletion $true `
                -Server $DnsIps[0] -Credential $credential
            Write-Output "Created OU $dn"
        }
        $parentDn = $dn
    }

    Add-Computer -DomainName $Config.domainName -Credential $credential -OUPath $parentDn -Force
    Write-Output "Joined $($Config.domainName) into $parentDn. Rebooting to continue (exit 3010)."
    exit 3010
}

# ----------------------------- Phase 2 -----------------------------
# The admin needs local administrator rights for the scheduled task (batch logon, elevated token).
try {
    Add-LocalGroupMember -SID 'S-1-5-32-544' -Member "$($Config.netBiosName)\Admin" -ErrorAction Stop
} catch {
    if ($_.FullyQualifiedErrorId -notmatch 'MemberExists') { throw }
}

$stage2Path = Join-Path $WorkDir 'Build-AdObjects.ps1'
$configPath = Join-Path $WorkDir 'config.json'
$resultPath = Join-Path $WorkDir 'result.txt'
$logPath = Join-Path $WorkDir 'build-ad-objects.log'
$stage2 = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Stage2Base64))
[IO.File]::WriteAllText($stage2Path, $stage2, (New-Object System.Text.UTF8Encoding $true))
[IO.File]::WriteAllText($configPath, ($Config | ConvertTo-Json -Depth 10), (New-Object System.Text.UTF8Encoding $false))
Remove-Item -Path $resultPath -ErrorAction SilentlyContinue

$taskName = 'WorkSpacesAdBootstrap'
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$stage2Path`" -ConfigPath `"$configPath`" -ResultPath `"$resultPath`" -LogPath `"$logPath`""
Register-ScheduledTask -TaskName $taskName -Action $action -User "$($Config.netBiosName)\Admin" `
    -Password $password -RunLevel Highest -Force | Out-Null
try {
    Start-ScheduledTask -TaskName $taskName
    $deadline = (Get-Date).AddMinutes(30)
    while (-not (Test-Path $resultPath) -and (Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 10
    }
} finally {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

if (Test-Path $logPath) { Get-Content -Path $logPath | Write-Output }
$result = if (Test-Path $resultPath) { (Get-Content -Path $resultPath -Raw).Trim() } else { 'TIMEOUT' }
if ($result -ne 'SUCCESS') {
    throw "Build-AdObjects.ps1 did not succeed: $result"
}

gpupdate /target:computer /force | Out-Null
Write-Output 'AD objects and GPOs are in place.'
