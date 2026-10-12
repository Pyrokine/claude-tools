import type { CommandShell } from './types.js'

export type CommandRisk = {
    level: 'medium' | 'high'
    categories: string[]
    signals: string[]
    suggestion: string
}

function withoutQuotedText(command: string, shell: CommandShell): string {
    let quote: "'" | '"' | undefined
    let escaped = false
    let result = ''
    for (const char of command) {
        if (escaped) {
            result += ' '
            escaped = false
        } else if (
            (shell === 'posix' && char === '\\' && quote !== "'") ||
            (shell === 'powershell' && char === '`' && quote !== "'") ||
            (shell === 'cmd' && char === '^' && !quote)
        ) {
            escaped = true
            result += ' '
        } else if (quote && char === quote) {
            quote = undefined
            result += ' '
        } else if (!quote && (char === '"' || (shell !== 'cmd' && char === "'"))) {
            quote = char
            result += ' '
        } else {
            result += quote ? ' ' : char
        }
    }
    return result
}

function hasBackgroundOperator(command: string): boolean {
    let quote: "'" | '"' | undefined
    let escaped = false
    for (let index = 0; index < command.length; ++index) {
        const char = command[index]
        if (escaped) {
            escaped = false
        } else if (char === '\\' && quote !== "'") {
            escaped = true
        } else if (quote && char === quote) {
            quote = undefined
        } else if (!quote && (char === "'" || char === '"')) {
            quote = char
        } else if (
            !quote &&
            char === '&' &&
            !'&<>'.includes(command[index - 1] ?? '') &&
            !'&>'.includes(command[index + 1] ?? '')
        ) {
            return true
        }
    }
    return false
}

export function classifyCommandRisk(
    command: string,
    timeout?: number,
    shell: CommandShell = 'posix'
): CommandRisk | undefined {
    const signals: string[] = []
    const categories = new Set<string>()
    const add = (category: string, signal: string): void => {
        categories.add(category)
        signals.push(signal)
    }
    const text = command.toLowerCase()
    const executable = withoutQuotedText(text, shell)
    if (shell === 'posix') {
        if (/(?:^|[;&|]\s*|\b(?:sudo|doas)\s+)(?:rm|mkfs|fdisk|parted|shutdown|reboot)(?=\s|$)/m.test(executable)) {
            add('destructive', 'destructive_command')
        }
        if (/\b(?:sudo|su\s+-|doas)\s+/.test(executable)) {
            add('privilege-escalation', 'privileged_command')
        }
        if (/\b(?:killall|pkill)\b|\bkill\s+(?!-0\b)/.test(executable)) {
            add('process-control', 'process_control')
        }
        if (/\b(?:systemctl|service|docker|kubectl)\s+(?:restart|stop|kill|delete|rm|down)\b/.test(executable)) {
            add('service-control', 'service_control')
        }
        if (!timeout || timeout > 300_000) {
            if (/\b(?:find\s+\S+|grep\s+-\S*[rR])\b/.test(executable)) {
                add('long-running', 'unbounded_search')
            }
        }
        if (/\b(?:tail\s+-f|journalctl\s+-f|watch|top|htop)\b/.test(executable)) {
            add('long-running', 'continuous_command')
        }
        if (hasBackgroundOperator(command)) {
            add('process-control', 'background_task')
        }
    } else if (shell === 'cmd') {
        if (/\b(?:del|erase|rmdir|rd)\s+(?!\/\?)|\bformat\s+[a-z]:/.test(executable)) {
            add('destructive', 'destructive_command')
        }
        if (/\btaskkill\s+\/f\b/.test(executable)) {
            add('process-control', 'process_control')
        }
        if (/\brunas\s+\/user:/.test(executable)) {
            add('privilege-escalation', 'privileged_command')
        }
        if ((!timeout || timeout > 300_000) && /\bdir\s+\/s\b/.test(executable)) {
            add('long-running', 'unbounded_search')
        }
    } else {
        if (/\b(?:remove-item|clear-content|format-volume)\b\s+/.test(executable)) {
            add('destructive', 'destructive_command')
        }
        if (/\b(?:stop-process|stop-service|restart-service)\b/.test(executable)) {
            add('process-control', 'process_control')
        }
        if (/\bstart-process\b[^\r\n;]*-verb\s+runas\b/.test(executable)) {
            add('privilege-escalation', 'privileged_command')
        }
        if ((!timeout || timeout > 300_000) && /\bget-childitem\b[^\r\n;]*-recurse\b/.test(executable)) {
            add('long-running', 'unbounded_search')
        }
    }
    const credentialArgument =
        /--password\b|--token\b|\$env:(?:password|token|secret)\s*=/.test(executable) ||
        (/\bset\s+"?/.test(executable) && /\bset\s+"?(?:password|token|secret)=/i.test(command))
    const authorizationHeader =
        /\b(?:curl|wget)\b[^\r\n;]*(?:-h|--header)\s*/.test(executable) &&
        /\b(?:curl|wget)\b[^\r\n;]*(?:-H|--header)\s+['"]?authorization:/i.test(command)
    if (credentialArgument || authorizationHeader) {
        add('credential-bearing', 'credential_argument')
    }
    if (signals.length === 0) {
        return undefined
    }
    const high =
        ['destructive', 'process-control', 'service-control', 'privilege-escalation'].some((category) =>
            categories.has(category)
        ) || signals.includes('continuous_command')
    return {
        level: high ? 'high' : 'medium',
        categories: [...categories],
        signals,
        suggestion:
            categories.has('privilege-escalation') && shell === 'posix'
                ? 'Use runAs or ssh_exec_as_user for user switching'
                : high
                  ? 'Confirm the target and scope before executing this command'
                  : 'Use a bounded timeout or redirect large output to a file',
    }
}
