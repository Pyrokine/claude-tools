import * as path from 'node:path'
import { escapeShellArg } from './tools/utils.js'
import type { CommandShell, RemotePathStyle, RemotePlatform } from './types.js'

export function remotePathModule(style: RemotePathStyle): typeof path.posix | typeof path.win32 {
    return style === 'win32' ? path.win32 : path.posix
}

export function remoteJoin(style: RemotePathStyle, parent: string, child: string): string {
    const joined = remotePathModule(style).join(parent, child)
    return style === 'sftp-posix' && parent.startsWith('//') ? `/${joined}` : joined
}

export function remoteDirname(style: RemotePathStyle, remotePath: string): string {
    const parent = remotePathModule(style).dirname(remotePath)
    return style === 'sftp-posix' && remotePath.startsWith('//') && parent.startsWith('/') && !parent.startsWith('//')
        ? `/${parent}`
        : parent
}

export function remoteNormalize(style: RemotePathStyle, remotePath: string): string {
    const normalized = remotePathModule(style).normalize(remotePath)
    return style === 'sftp-posix' && remotePath.startsWith('//') ? `/${normalized}` : normalized
}

export function remotePathStyle(platform: RemotePlatform, style?: RemotePathStyle): RemotePathStyle {
    return style ?? (platform === 'windows' ? 'win32' : 'posix')
}

export function sftpPath(remotePath: string, style: RemotePathStyle): string {
    if (style !== 'sftp-posix') {
        return remotePath
    }
    if (/^[a-zA-Z]:[\\/]/.test(remotePath)) {
        return `/${remotePath[0].toUpperCase()}:${remotePath.slice(2).replace(/\\/g, '/')}`
    }
    if (remotePath.startsWith('\\\\')) {
        return `//${remotePath.slice(2).replace(/\\/g, '/')}`
    }
    return remotePath.replace(/\\/g, '/')
}

export function remoteShellPath(remotePath: string, style: RemotePathStyle): string {
    if (style !== 'sftp-posix') {
        return remotePath
    }
    const drive = /^\/([a-zA-Z]):(?:\/(.*))?$/.exec(remotePath)
    if (drive) {
        return `${drive[1].toUpperCase()}:\\${(drive[2] ?? '').replace(/\//g, '\\')}`
    }
    if (/^\/\/[^/]+\/[^/]+/.test(remotePath)) {
        return `\\\\${remotePath.slice(2).replace(/\//g, '\\')}`
    }
    throw new Error('Windows shell path cannot be derived from this SFTP path; use a drive or UNC path')
}

export function quotePowershell(value: string): string {
    return `'${value.replace(/'/g, "''")}'`
}

export function encodedPowershell(script: string): string {
    return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
}

export function windowsCaseSemanticsScript(parent: string, names: string[]): string {
    return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class McpCaseSemantics {
    [StructLayout(LayoutKind.Sequential)]
    public struct FILE_CASE_SENSITIVE_INFO { public uint Flags; }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    public static extern SafeFileHandle CreateFileW(string path, uint access, uint share, IntPtr security, uint disposition, uint attributes, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int infoClass, out FILE_CASE_SENSITIVE_INFO info, uint size);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, ExactSpelling = true)]
    public static extern int CompareStringOrdinal(string left, int leftLength, string right, int rightLength, [MarshalAs(UnmanagedType.Bool)] bool ignoreCase);
    private static int Compare(string left, string right) {
        int result = CompareStringOrdinal(left, left.Length, right, right.Length, true);
        if (result == 0) { throw new Win32Exception(Marshal.GetLastWin32Error()); }
        return result - 2;
    }
    public static uint DirectoryFlags(string parent) {
        // FILE_READ_ATTRIBUTES; FILE_SHARE_READ | WRITE | DELETE; OPEN_EXISTING; NORMAL | BACKUP_SEMANTICS.
        using (SafeFileHandle handle = CreateFileW(parent, 128, 7, IntPtr.Zero, 3, 128 | 33554432, IntPtr.Zero)) {
            if (handle.IsInvalid) { throw new Win32Exception(Marshal.GetLastWin32Error()); }
            FILE_CASE_SENSITIVE_INFO info;
            if (!GetFileInformationByHandleEx(handle, 23, out info, 4)) { throw new Win32Exception(Marshal.GetLastWin32Error()); }
            return info.Flags;
        }
    }
    public static string[] Collision(string[] names) {
        Array.Sort(names, Compare);
        for (int i = 1; i < names.Length; ++i) {
            if (Compare(names[i - 1], names[i]) == 0) { return new string[] { names[i - 1], names[i] }; }
        }
        return null;
    }
}
'@
$parent = ${quotePowershell(parent)}
if (-not [System.IO.Directory]::Exists($parent)) { throw 'candidate parent directory does not exist' }
$caseSensitive = ([McpCaseSemantics]::DirectoryFlags($parent) -band 1) -ne 0
$names = [string[]]@(${names.map(quotePowershell).join(', ')})
$collision = $null
if (-not $caseSensitive) { $collision = [McpCaseSemantics]::Collision($names) }
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
@{ caseSensitive = $caseSensitive; collision = $collision } | ConvertTo-Json -Compress`
}

export function buildRemoteCommand(
    command: string,
    shell: CommandShell,
    cwd: string | undefined,
    env: Record<string, string>
): string {
    const validKey = /^[a-zA-Z_][a-zA-Z0-9_]*$/
    for (const key of Object.keys(env)) {
        if (!validKey.test(key)) {
            throw new Error(`Invalid environment variable name: ${key}`)
        }
    }
    if (shell === 'powershell') {
        const setup = [
            ...(cwd ? [`Set-Location -LiteralPath ${quotePowershell(cwd)}; if (-not $?) { throw 'cwd failed' }`] : []),
            ...Object.entries(env).map(([key, value]) => `$env:${key} = ${quotePowershell(value)}`),
        ]
        return encodedPowershell(`& { ${setup.join('; ')}; & { ${command} }; if (-not $?) { exit 1 } }`)
    }
    if (shell === 'cmd') {
        if (!cwd && Object.keys(env).length === 0) {
            return `cmd.exe /D /V:OFF /S /C "(${command})"`
        }
        const setup = [
            ...(cwd ? [`Set-Location -LiteralPath ${quotePowershell(cwd)}`] : []),
            ...Object.entries(env).map(([key, value]) => `$env:${key} = ${quotePowershell(value)}`),
        ]
        return encodedPowershell(
            `$ErrorActionPreference = 'Stop'; ${setup.join('; ')}; & cmd.exe /D /V:OFF /S /C ${quotePowershell(command)}; exit $LASTEXITCODE`
        )
    }
    const setup = [
        ...(cwd ? [`cd ${escapeShellArg(cwd)}`] : []),
        ...Object.entries(env).map(([key, value]) => `export ${key}=${escapeShellArg(value)}`),
    ]
    return setup.length ? `${setup.join(' && ')} && eval ${escapeShellArg(command)}` : command
}
