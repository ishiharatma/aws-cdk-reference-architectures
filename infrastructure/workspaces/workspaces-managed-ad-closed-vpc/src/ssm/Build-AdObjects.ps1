# ---------------------------------------------------------------------------
# Creates the OU tree, security groups, PSO settings and GPOs of the WorkSpaces environment.
# Runs as <NetBIOS>\Admin through a one-shot scheduled task started by
# bootstrap-management-instance.ps1. Every step is idempotent so that the association can be
# re-run after a parameter change.
#
# All writes go to the PDC emulator so later steps never read a DC that has not replicated yet.
# ---------------------------------------------------------------------------
param(
    [Parameter(Mandatory)] [string]$ConfigPath,
    [Parameter(Mandatory)] [string]$ResultPath,
    [Parameter(Mandatory)] [string]$LogPath
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Start-Transcript -Path $LogPath -Force | Out-Null

try {
    $Config = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json
    Import-Module ActiveDirectory, GroupPolicy

    $domain = Get-ADDomain
    $domainDn = $domain.DistinguishedName
    $dnsRoot = $domain.DNSRoot
    $pdc = $domain.PDCEmulator
    $baseDn = "OU=$($Config.netBiosName),$domainDn"

    function Resolve-RelativeDn([string]$Relative) {
        if ([string]::IsNullOrEmpty($Relative)) { return $baseDn }
        return "$Relative,$baseDn"
    }

    # ======================================================================
    # 1. Organizational units
    # ======================================================================
    foreach ($ou in $Config.organizationalUnits) {
        $parentDn = Resolve-RelativeDn $ou.parent
        $dn = "OU=$($ou.name),$parentDn"
        if (Get-ADOrganizationalUnit -Filter "DistinguishedName -eq '$dn'" -Server $pdc) {
            Set-ADOrganizationalUnit -Identity $dn -Description $ou.description -Server $pdc
        } else {
            New-ADOrganizationalUnit -Name $ou.name -Path $parentDn -Description $ou.description `
                -ProtectedFromAccidentalDeletion $true -Server $pdc
            Write-Host "Created OU $dn"
        }
    }

    # ======================================================================
    # 2. Security groups
    # ======================================================================
    foreach ($group in $Config.groups) {
        $path = Resolve-RelativeDn $group.parent
        if (-not (Get-ADGroup -Filter "SamAccountName -eq '$($group.name)'" -Server $pdc)) {
            New-ADGroup -Name $group.name -SamAccountName $group.name -GroupScope Global `
                -GroupCategory Security -Path $path -Description $group.description -Server $pdc
            Write-Host "Created group $($group.name)"
        }
    }

    # ======================================================================
    # 3. Fine-grained password policy (PSO pre-created by Managed AD)
    # ======================================================================
    $pso = $Config.passwordPolicy
    Set-ADFineGrainedPasswordPolicy -Identity $pso.psoName -Server $pdc `
        -MinPasswordLength $pso.minPasswordLength `
        -PasswordHistoryCount $pso.passwordHistoryCount `
        -MaxPasswordAge (New-TimeSpan -Days $pso.maxPasswordAgeDays) `
        -LockoutThreshold $pso.lockoutThreshold `
        -LockoutDuration (New-TimeSpan -Minutes $pso.lockoutDurationMinutes) `
        -LockoutObservationWindow (New-TimeSpan -Minutes $pso.lockoutObservationWindowMinutes) `
        -ComplexityEnabled $true -ReversibleEncryptionEnabled $false
    $subjects = @(Get-ADFineGrainedPasswordPolicySubject -Identity $pso.psoName -Server $pdc)
    if (-not ($subjects | Where-Object { $_.Name -eq $pso.appliesToGroup })) {
        Add-ADFineGrainedPasswordPolicySubject -Identity $pso.psoName -Subjects $pso.appliesToGroup -Server $pdc
        Write-Host "Applied $($pso.psoName) to $($pso.appliesToGroup)"
    }

    # ======================================================================
    # 4. GPO helpers
    # ======================================================================
    function Get-OrNewGpo([string]$Name, [string]$Comment) {
        $gpo = Get-GPO -Name $Name -Domain $dnsRoot -Server $pdc -ErrorAction SilentlyContinue
        if (-not $gpo) {
            $gpo = New-GPO -Name $Name -Comment $Comment -Domain $dnsRoot -Server $pdc
            Write-Host "Created GPO $Name"
        }
        return $gpo
    }

    function Add-GpoLinkOnce($Gpo, [string]$TargetDn) {
        $links = (Get-GPInheritance -Target $TargetDn -Domain $dnsRoot -Server $pdc).GpoLinks
        if (-not ($links | Where-Object { $_.GpoId -eq $Gpo.Id })) {
            New-GPLink -Guid $Gpo.Id -Target $TargetDn -LinkEnabled Yes -Domain $dnsRoot -Server $pdc | Out-Null
            Write-Host "Linked $($Gpo.DisplayName) to $TargetDn"
        }
    }

    function Set-PolicyDword($Gpo, [string]$Key, [string]$Name, [int]$Value) {
        Set-GPRegistryValue -Guid $Gpo.Id -Key $Key -ValueName $Name -Type DWord -Value $Value `
            -Domain $dnsRoot -Server $pdc | Out-Null
    }

    function Set-PolicyString($Gpo, [string]$Key, [string]$Name, [string]$Value) {
        Set-GPRegistryValue -Guid $Gpo.Id -Key $Key -ValueName $Name -Type String -Value $Value `
            -Domain $dnsRoot -Server $pdc | Out-Null
    }

    function Get-GpoSysvolPath($Gpo) {
        return "\\$pdc\SYSVOL\$dnsRoot\Policies\{$($Gpo.Id)}"
    }

    # Settings written as files into SYSVOL (audit.csv, Groups.xml) are only processed when
    # the client-side extension is listed in gPCMachineExtensionNames and the machine version
    # increases, which is what the GPMC editor does behind the scenes.
    function Register-MachineExtension($Gpo, [string[]]$ExtensionBlocks) {
        $gpoDn = "CN={$($Gpo.Id)},CN=Policies,CN=System,$domainDn"
        $obj = Get-ADObject -Identity $gpoDn -Properties gPCMachineExtensionNames, versionNumber -Server $pdc
        $existing = @()
        if ($obj.gPCMachineExtensionNames) {
            $existing = @([regex]::Matches($obj.gPCMachineExtensionNames, '\[[^\]]+\]') | ForEach-Object { $_.Value })
        }
        $merged = (@($existing + $ExtensionBlocks) | ForEach-Object { $_.ToUpperInvariant() } |
            Sort-Object -Unique) -join ''
        # The low 16 bits are the computer-side version.
        $newVersion = [int]$obj.versionNumber + 1
        Set-ADObject -Identity $gpoDn -Server $pdc `
            -Replace @{ gPCMachineExtensionNames = $merged; versionNumber = $newVersion }
        $gptIni = Join-Path (Get-GpoSysvolPath $Gpo) 'GPT.INI'
        $content = (Get-Content -Path $gptIni) -replace '^Version=\d+', "Version=$newVersion"
        Set-Content -Path $gptIni -Value $content -Encoding ASCII
    }

    $workspacesOuDn = Resolve-RelativeDn $Config.gpoTargets.workspacesOu
    $adminOuDn = Resolve-RelativeDn $Config.gpoTargets.adminOu
    $gp = $Config.groupPolicy

    # ======================================================================
    # 5. GPO-WS-Security (OU=WorkSpaces)
    #    DCV settings (clipboard, screen capture, file transfer, printer, USB, idle disconnect)
    #    need wsp.admx from a running WorkSpace; install it with the InstallDcvAdmx document and
    #    configure them in GPMC. Only the Windows idle lock is set here.
    # ======================================================================
    $securityGpo = Get-OrNewGpo 'GPO-WS-Security' 'Data exfiltration and idle controls for WorkSpaces'
    Set-PolicyDword $securityGpo 'HKLM\Software\Microsoft\Windows\CurrentVersion\Policies\System' `
        'InactivityTimeoutSecs' $gp.inactivityTimeoutSeconds
    Add-GpoLinkOnce $securityGpo $workspacesOuDn

    # ======================================================================
    # 6. GPO-WS-Audit (OU=WorkSpaces)
    # ======================================================================
    $auditGpo = Get-OrNewGpo 'GPO-WS-Audit' 'Process / PowerShell auditing and WinRM for log collection'
    # Include command line in process creation events (4688)
    Set-PolicyDword $auditGpo 'HKLM\Software\Microsoft\Windows\CurrentVersion\Policies\System\Audit' `
        'ProcessCreationIncludeCmdLine_Enabled' 1
    # PowerShell script block logging (4104)
    Set-PolicyDword $auditGpo 'HKLM\Software\Policies\Microsoft\Windows\PowerShell\ScriptBlockLogging' `
        'EnableScriptBlockLogging' 1
    # Security log size (KB)
    Set-PolicyDword $auditGpo 'HKLM\Software\Policies\Microsoft\Windows\EventLog\Security' `
        'MaxSize' $gp.securityLogMaxSizeKb
    # Advanced audit policy must override the legacy category policy
    Set-PolicyDword $auditGpo 'HKLM\System\CurrentControlSet\Control\Lsa' 'SCENoApplyLegacyAuditPolicy' 1
    # WinRM listener restricted to the management subnets
    Set-PolicyDword $auditGpo 'HKLM\Software\Policies\Microsoft\Windows\WinRM\Service' 'AllowAutoConfig' 1
    Set-PolicyString $auditGpo 'HKLM\Software\Policies\Microsoft\Windows\WinRM\Service' 'IPv4Filter' `
        $Config.winRm.ipv4Filter
    # WinRM service: automatic start (preference item, not a policy key)
    $winRmStart = Get-GPPrefRegistryValue -Guid $auditGpo.Id -Context Computer `
        -Key 'HKLM\SYSTEM\CurrentControlSet\Services\WinRM' -ValueName 'Start' `
        -Domain $dnsRoot -Server $pdc -ErrorAction SilentlyContinue
    if (-not $winRmStart) {
        Set-GPPrefRegistryValue -Guid $auditGpo.Id -Context Computer -Action Update `
            -Key 'HKLM\SYSTEM\CurrentControlSet\Services\WinRM' -ValueName 'Start' -Type DWord -Value 2 `
            -Domain $dnsRoot -Server $pdc | Out-Null
    }
    # Windows Firewall: TCP 5985 from the management subnets only
    $policyStore = "$dnsRoot\GPO-WS-Audit"
    $ruleName = 'WS-WinRM-HTTP-In-From-Management'
    if (-not (Get-NetFirewallRule -PolicyStore $policyStore -Name $ruleName -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -PolicyStore $policyStore -Name $ruleName `
            -DisplayName 'WinRM (HTTP-In) from management subnets' -Direction Inbound -Protocol TCP `
            -LocalPort 5985 -RemoteAddress @($Config.winRm.remoteAddresses) -Action Allow -Profile Any | Out-Null
    }
    # Advanced audit policy: Detailed Tracking > Audit Process Creation = Success (4688)
    $auditDir = Join-Path (Get-GpoSysvolPath $auditGpo) 'Machine\Microsoft\Windows NT\Audit'
    New-Item -ItemType Directory -Path $auditDir -Force | Out-Null
    Set-Content -Path (Join-Path $auditDir 'audit.csv') -Encoding ASCII -Value @(
        'Machine Name,Policy Target,Subcategory,Subcategory GUID,Inclusion Setting,Exclusion Setting,Setting Value',
        ',System,Audit Process Creation,{0cce922b-69ae-11d9-bed3-505054503030},Success,,1'
    )
    Register-MachineExtension $auditGpo @(
        '[{F3CCC681-B74C-4060-9F26-CD84525DCA2A}{0F3F3735-573D-9804-99E4-AB2A69BA5FD4}]'
    )
    Add-GpoLinkOnce $auditGpo $workspacesOuDn

    # ======================================================================
    # 7. GPO-WS-LocalAdmin (OU=WorkSpaces)
    #    Group Policy Preferences > Local Users and Groups: rebuild the built-in Administrators
    #    group from AD groups so local admin is granted / revoked by group membership.
    # ======================================================================
    $localAdminGpo = Get-OrNewGpo 'GPO-WS-LocalAdmin' 'Local Administrators membership managed by AD groups'
    $members = @('<Member name="%ComputerName%\Administrator" action="ADD" sid=""/>')
    foreach ($groupName in $Config.localAdministratorGroups) {
        $sid = (Get-ADGroup -Identity $groupName -Server $pdc).SID.Value
        $members += "<Member name=`"$($Config.netBiosName)\$groupName`" action=`"ADD`" sid=`"$sid`"/>"
    }
    $changed = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss')
    $groupsXml = @"
<?xml version="1.0" encoding="utf-8"?>
<Groups clsid="{3125E937-EB16-4b4c-9934-544FC6D24D26}"><Group clsid="{6D4A79E4-529C-4481-ABD0-F5BD7EA93BA7}" name="Administrators (built-in)" image="2" changed="$changed" uid="{2B7F5C1E-6A43-4C1D-9B5E-3F8A0D2C7E41}"><Properties action="U" newName="" description="" deleteAllUsers="1" deleteAllGroups="1" removeAccounts="0" groupSid="S-1-5-32-544" groupName="Administrators (built-in)"><Members>$($members -join '')</Members></Properties></Group></Groups>
"@
    $groupsDir = Join-Path (Get-GpoSysvolPath $localAdminGpo) 'Machine\Preferences\Groups'
    New-Item -ItemType Directory -Path $groupsDir -Force | Out-Null
    [IO.File]::WriteAllText((Join-Path $groupsDir 'Groups.xml'), $groupsXml, (New-Object System.Text.UTF8Encoding $false))
    Register-MachineExtension $localAdminGpo @(
        '[{00000000-0000-0000-0000-000000000000}{79F92669-4224-476C-9C5C-6EFB4D87DF4A}]',
        '[{17D89FEC-5C44-4972-B12D-241CAEF74509}{79F92669-4224-476C-9C5C-6EFB4D87DF4A}]'
    )
    Add-GpoLinkOnce $localAdminGpo $workspacesOuDn

    # ======================================================================
    # 8. GPO-Admin (OU=Admin): minimal hardening of the management instance
    # ======================================================================
    $adminGpo = Get-OrNewGpo 'GPO-Admin' 'Minimal protection of management instances'
    Set-PolicyDword $adminGpo 'HKLM\Software\Microsoft\Windows\CurrentVersion\Policies\System' `
        'InactivityTimeoutSecs' $gp.inactivityTimeoutSeconds
    Add-GpoLinkOnce $adminGpo $adminOuDn

    Set-Content -Path $ResultPath -Value 'SUCCESS'
} catch {
    Write-Host "ERROR: $($_ | Out-String)"
    Set-Content -Path $ResultPath -Value "FAILED: $($_.Exception.Message)"
} finally {
    Stop-Transcript | Out-Null
}
