import { spawnSync } from 'node:child_process'
import { encodedPowershell, quotePowershell } from './remote-platform.js'

export type AclStatus = 'key_path_usable' | 'key_acl_insecure' | 'key_acl_unverified'

export function windowsAclScript(filePath: string, apply: boolean): string {
    const target = quotePowershell(filePath)
    return `
$ErrorActionPreference = 'Stop'
$path = ${target}
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administrators = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$allowed = @($identity.Value, $system.Value, $administrators.Value)
$acl = Get-Acl -LiteralPath $path
${
    apply
        ? `
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier]))) {
    $acl.RemoveAccessRuleSpecific($rule)
}
foreach ($sid in @($identity, $system, $administrators)) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, [System.Security.AccessControl.AccessControlType]::Allow)
    $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $path -AclObject $acl
$acl = Get-Acl -LiteralPath $path
`
        : ''
}
if (-not $acl.AreAccessRulesProtected -or
    $allowed -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) {
    [Console]::WriteLine('insecure'); exit 0
}
$own = $false
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow') {
        if ($allowed -notcontains $rule.IdentityReference.Value) { [Console]::WriteLine('insecure'); exit 0 }
        if ($rule.IdentityReference.Value -eq $identity.Value) { $own = $true }
    }
}
if (-not $own) { [Console]::WriteLine('insecure'); exit 0 }
$item = Get-Item -LiteralPath $path -Force
if ($item -is [IO.FileInfo]) {
    try {
        $stream = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        $stream.Dispose()
    } catch {
        [Console]::WriteLine('unverified'); exit 0
    }
}
[Console]::WriteLine('usable')
`
}

export function windowsTemporaryPathScript(name: string): string {
    return `
$ErrorActionPreference = 'Stop'
$temp = [IO.Path]::GetTempPath()
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$administrators = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$allowed = @($identity.Value, $system.Value, $administrators.Value)
$directory = Get-Item -LiteralPath $temp -Force
if ($directory -isnot [IO.DirectoryInfo]) { throw 'privacy_not_enforced_on_windows: temporary path is not a directory' }
$current = $directory
while ($null -ne $current) {
    if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw 'privacy_not_enforced_on_windows: temporary directory has a reparse point'
    }
    $acl = Get-Acl -LiteralPath $current.FullName
    if ($current.FullName -eq $directory.FullName -and $allowed -notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) {
        throw 'privacy_not_enforced_on_windows: temporary directory owner is not trusted'
    }
    $rights = [System.Security.AccessControl.FileSystemRights]::Delete -bor
        [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [System.Security.AccessControl.FileSystemRights]::TakeOwnership
    if ($current.FullName -eq $directory.FullName) {
        $rights = $rights -bor [System.Security.AccessControl.FileSystemRights]::Write
    }
    foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
        if ($rule.AccessControlType -eq 'Allow' -and
            $allowed -notcontains $rule.IdentityReference.Value -and
            ($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and
            ($rule.FileSystemRights -band $rights) -ne 0) {
            throw 'privacy_not_enforced_on_windows: temporary directory allows another user to replace entries'
        }
    }
    $current = $current.Parent
}
[Console]::WriteLine([IO.Path]::Combine($directory.FullName, ${quotePowershell(name)}))
`
}

export function checkWindowsAcl(filePath: string, apply: boolean = false): AclStatus {
    if (process.platform !== 'win32') {
        throw new Error('Windows ACL verification requires a native Windows process')
    }
    const command = encodedPowershell(windowsAclScript(filePath, apply))
    const encoded = command.split(' ').at(-1)!
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        timeout: 10_000,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16_384,
    })
    if (result.error || result.status !== 0) {
        return 'key_acl_unverified'
    }
    if (result.stdout.trim() === 'usable') {
        return 'key_path_usable'
    }
    return result.stdout.trim() === 'insecure' ? 'key_acl_insecure' : 'key_acl_unverified'
}
