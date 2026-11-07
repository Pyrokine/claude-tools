import { spawnSync } from 'node:child_process'
import { encodedPowershell, quotePowershell } from './remote-platform.js'

export type AclStatus = 'key_path_usable' | 'key_acl_insecure' | 'key_acl_unverified'

export function windowsAclScript(filePath: string, apply: boolean): string {
    const target = quotePowershell(filePath)
    return (
        '\n' +
        "$ErrorActionPreference = 'Stop'\n" +
        '$path = ' +
        `${target}` +
        '\n' +
        '$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Us' +
        'er\n' +
        "$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'" +
        ')\n' +
        "$administrators = [System.Security.Principal.SecurityIdentifier]::new('S" +
        "-1-5-32-544')\n" +
        '$allowed = @($identity.Value, $system.Value, $administrators.Value)\n' +
        '$acl = Get-Acl -LiteralPath $path\n' +
        `${
            apply
                ? '\n' +
                  '$acl.SetAccessRuleProtection($true, $false)\n' +
                  'foreach ($rule in @($acl.GetAccessRules($true, $true, ' +
                  '[System.Security.Principal.SecurityIdentifier]))) {\n' +
                  '    $acl.RemoveAccessRuleSpecific($rule)\n' +
                  '}\n' +
                  'foreach ($sid in @($identity, $system, $administrators)) {\n' +
                  '    $rule = [System.Security.AccessControl.FileSystemAccessRule]::ne' +
                  'w($sid, [System.Security.AccessControl.FileSystemRights]::FullContro' +
                  'l, [System.Security.AccessControl.AccessControlType]::Allow)\n' +
                  '    $acl.AddAccessRule($rule)\n' +
                  '}\n' +
                  'Set-Acl -LiteralPath $path -AclObject $acl\n' +
                  '$acl = Get-Acl -LiteralPath $path\n'
                : ''
        }` +
        '\n' +
        'if (-not $acl.AreAccessRulesProtected -or\n' +
        '    $allowed -notcontains ' +
        '$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value) {\n' +
        "    [Console]::WriteLine('insecure'); exit 0\n" +
        '}\n' +
        '$own = $false\n' +
        'foreach ($rule in $acl.GetAccessRules($true, $true, ' +
        '[System.Security.Principal.SecurityIdentifier])) {\n' +
        "    if ($rule.AccessControlType -eq 'Allow') {\n" +
        '        if ($allowed -notcontains $rule.IdentityReference.Value) { ' +
        "[Console]::WriteLine('insecure'); exit 0 }\n" +
        '        if ($rule.IdentityReference.Value -eq $identity.Value) { $own = ' +
        '$true }\n' +
        '    }\n' +
        '}\n' +
        "if (-not $own) { [Console]::WriteLine('insecure'); exit 0 }\n" +
        '$item = Get-Item -LiteralPath $path -Force\n' +
        'if ($item -is [IO.FileInfo]) {\n' +
        '    try {\n' +
        '        $stream = [IO.File]::Open($path, [IO.FileMode]::Open, ' +
        '[IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)\n' +
        '        $stream.Dispose()\n' +
        '    } catch {\n' +
        "        [Console]::WriteLine('unverified'); exit 0\n" +
        '    }\n' +
        '}\n' +
        "[Console]::WriteLine('usable')\n"
    )
}

export function windowsTemporaryPathScript(name: string): string {
    return (
        '\n' +
        "$ErrorActionPreference = 'Stop'\n" +
        '$temp = [IO.Path]::GetTempPath()\n' +
        '$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent().Us' +
        'er\n' +
        "$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18'" +
        ')\n' +
        "$administrators = [System.Security.Principal.SecurityIdentifier]::new('S" +
        "-1-5-32-544')\n" +
        '$allowed = @($identity.Value, $system.Value, $administrators.Value)\n' +
        '$directory = Get-Item -LiteralPath $temp -Force\n' +
        'if ($directory -isnot [IO.DirectoryInfo]) { throw ' +
        "'privacy_not_enforced_on_windows: temporary path is not a directory' }\n" +
        '$current = $directory\n' +
        'while ($null -ne $current) {\n' +
        '    if (($current.Attributes -band [IO.FileAttributes]::ReparsePoint) ' +
        '-ne 0) {\n' +
        "        throw 'privacy_not_enforced_on_windows: temporary directory has " +
        "a reparse point'\n" +
        '    }\n' +
        '    $acl = Get-Acl -LiteralPath $current.FullName\n' +
        '    if ($current.FullName -eq $directory.FullName -and $allowed ' +
        '-notcontains $acl.GetOwner([System.Security.Principal.SecurityIdentifier' +
        ']).Value) {\n' +
        "        throw 'privacy_not_enforced_on_windows: temporary directory " +
        "owner is not trusted'\n" +
        '    }\n' +
        '    $rights = [System.Security.AccessControl.FileSystemRights]::Delete ' +
        '-bor\n' +
        '        [System.Security.AccessControl.FileSystemRights]::DeleteSubdirec' +
        'toriesAndFiles -bor\n' +
        '        [System.Security.AccessControl.FileSystemRights]::ChangePermissi' +
        'ons -bor\n' +
        '        [System.Security.AccessControl.FileSystemRights]::TakeOwnership\n' +
        '    if ($current.FullName -eq $directory.FullName) {\n' +
        '        $rights = $rights -bor ' +
        '[System.Security.AccessControl.FileSystemRights]::Write\n' +
        '    }\n' +
        '    foreach ($rule in $acl.GetAccessRules($true, $true, ' +
        '[System.Security.Principal.SecurityIdentifier])) {\n' +
        "        if ($rule.AccessControlType -eq 'Allow' -and\n" +
        '            $allowed -notcontains $rule.IdentityReference.Value -and\n' +
        '            ($rule.PropagationFlags -band ' +
        '[System.Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 ' +
        '-and\n' +
        '            ($rule.FileSystemRights -band $rights) -ne 0) {\n' +
        "            throw 'privacy_not_enforced_on_windows: temporary directory " +
        "allows another user to replace entries'\n" +
        '        }\n' +
        '    }\n' +
        '    $current = $current.Parent\n' +
        '}\n' +
        '[Console]::WriteLine([IO.Path]::Combine($directory.FullName, ' +
        `${quotePowershell(name)}` +
        '))\n'
    )
}

export function checkWindowsKnownHostsIntegrity(filePath: string): void {
    if (process.platform !== 'win32') {
        throw new Error('Windows ACL verification requires a native Windows process')
    }
    const script =
        "$ErrorActionPreference = 'Stop'\n" +
        '$identity = [Security.Principal.WindowsIdentity]::GetCurrent().User.Valu' +
        'e\n' +
        "$trustedInstaller = [Security.Principal.NTAccount]::new('NT " +
        "SERVICE\\TrustedInstaller').Translate([Security.Principal.SecurityIdentif" +
        'ier]).Value\n' +
        "$allowed = @($identity, 'S-1-5-18', 'S-1-5-32-544', $trustedInstaller)\n" +
        '$current = Get-Item -LiteralPath ' +
        `${quotePowershell(filePath)}` +
        ' -Force\n' +
        '$target = $current.FullName\n' +
        '$container = if ($current -is [IO.DirectoryInfo]) { $current.FullName } ' +
        'else { $current.Directory.FullName }\n' +
        'while ($null -ne $current) {\n' +
        '    $acl = Get-Acl -LiteralPath $current.FullName\n' +
        '    if ($allowed -notcontains ' +
        '$acl.GetOwner([Security.Principal.SecurityIdentifier]).Value) { throw ' +
        "'untrusted owner' }\n" +
        '    $rights = [Security.AccessControl.FileSystemRights]::Delete -bor\n' +
        '        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesA' +
        'ndFiles -bor\n' +
        '        [Security.AccessControl.FileSystemRights]::ChangePermissions ' +
        '-bor\n' +
        '        [Security.AccessControl.FileSystemRights]::TakeOwnership\n' +
        '    if ($current.FullName -eq $target -or $current.FullName -eq ' +
        '$container) {\n' +
        '        $rights = $rights -bor ' +
        '[Security.AccessControl.FileSystemRights]::Write\n' +
        '    }\n' +
        '    foreach ($rule in $acl.GetAccessRules($true, $true, ' +
        '[Security.Principal.SecurityIdentifier])) {\n' +
        "        if ($rule.AccessControlType -eq 'Allow' -and\n" +
        '            $allowed -notcontains $rule.IdentityReference.Value -and\n' +
        '            ($rule.PropagationFlags -band ' +
        '[Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and\n' +
        '            ($rule.FileSystemRights -band $rights) -ne 0) { throw ' +
        "'untrusted writer' }\n" +
        '    }\n' +
        '    $current = if ($current -is [IO.DirectoryInfo]) { $current.Parent } ' +
        'else { $current.Directory }\n' +
        '}\n' +
        "[Console]::Write('verified')"
    const encoded = encodedPowershell(script).split(' ').at(-1)!
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        timeout: 10_000,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 16_384,
    })
    if (result.error || result.status !== 0 || result.stdout.trim() !== 'verified') {
        throw new Error('known_hosts write integrity could not be verified on Windows')
    }
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
