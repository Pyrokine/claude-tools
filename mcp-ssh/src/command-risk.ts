import type { CommandShell } from './types.js'

export type CommandRisk = {
    level: 'medium' | 'high'
    categories: string[]
    signals: string[]
    suggestion: string
}

function withoutQuotedText(command: string, shell: CommandShell): string {
    let index = 0
    // Shell commands, here-doc input, and arithmetic share the same expansion scanner.
    const scan = (mode: 'shell' | 'input' | 'arithmetic', limit: number, closing?: ')' | '`'): string => {
        let quote: "'" | '"' | undefined
        let parentheses = 0
        let result = ''
        const hereDocs: { delimiter: string; expand: boolean; stripTabs: boolean }[] = []
        let delimiter: { value: string; quoted: boolean; started: boolean; stripTabs: boolean } | undefined
        while (index < limit) {
            const char = command[index]
            const next = command[index + 1]
            if (delimiter) {
                if (!quote && /[\s;&|<>()]/.test(char)) {
                    if (!delimiter.started && /[ \t]/.test(char)) {
                        ++index
                        continue
                    }
                    if (delimiter.started) {
                        hereDocs.push({
                            delimiter: delimiter.value,
                            expand: !delimiter.quoted,
                            stripTabs: delimiter.stripTabs,
                        })
                    }
                    delimiter = undefined
                    continue
                }
                if (char === '\\' && quote !== "'" && (!quote || /[$`"\\\n]/.test(next ?? ''))) {
                    if (next !== '\n') {
                        delimiter.started = true
                        delimiter.quoted = true
                        delimiter.value += next ?? ''
                    }
                    index += 2
                } else if (quote && char === quote) {
                    quote = undefined
                    ++index
                } else if (!quote && (char === "'" || char === '"')) {
                    delimiter.started = true
                    delimiter.quoted = true
                    quote = char
                    ++index
                } else {
                    delimiter.started = true
                    delimiter.value += char
                    ++index
                }
                continue
            }
            const escapes =
                (shell === 'posix' &&
                    char === '\\' &&
                    quote !== "'" &&
                    ((mode === 'shell' && !quote) || /[$`"\\\n]/.test(next ?? ''))) ||
                (shell === 'powershell' && char === '`' && quote !== "'") ||
                (shell === 'cmd' && char === '^' && !quote)
            if (escapes) {
                result += next === '\n' ? '' : '  '
                index += 2
                continue
            }
            if (shell === 'posix' && quote !== "'") {
                if (char === '$' && next === '(') {
                    const arithmetic = command[index + 2] === '('
                    index += arithmetic ? 3 : 2
                    result += `;${scan(arithmetic ? 'arithmetic' : 'shell', limit, ')')};`
                    if (arithmetic && command[index] === ')') {
                        ++index
                    }
                    continue
                }
                if (char === '`' && closing !== '`') {
                    ++index
                    result += `;${scan('shell', limit, '`')};`
                    continue
                }
            }
            if (!quote && mode !== 'input' && closing && char === closing && parentheses === 0) {
                ++index
                return result
            }
            if (mode === 'input') {
                result += char === '\n' ? '\n' : ' '
                ++index
                continue
            }
            if (quote && char === quote) {
                quote = undefined
                result += ' '
            } else if (!quote && (char === '"' || (shell !== 'cmd' && char === "'"))) {
                quote = char
                result += ' '
            } else if (
                shell === 'posix' &&
                !quote &&
                char === '#' &&
                (index === 0 || /[\s;&|()]/.test(command[index - 1]))
            ) {
                while (index < limit && command[index] !== '\n') {
                    ++index
                }
                continue
            } else if (shell === 'posix' && !quote && mode === 'shell' && char === '<' && next === '<') {
                if (command[index + 2] === '<') {
                    result += '<<<'
                    index += 3
                    continue
                }
                const stripTabs = command[index + 2] === '-'
                delimiter = { value: '', quoted: false, started: false, stripTabs }
                index += stripTabs ? 3 : 2
                result += ' '
                continue
            } else if (shell === 'posix' && !quote && char === '\n' && hereDocs.length > 0) {
                ++index
                result += '\n'
                for (const doc of hereDocs.splice(0)) {
                    const bodyStart = index
                    let bodyEnd = limit
                    let afterDelimiter = limit
                    // Delimiters are case-sensitive; input quotes never change Shell quote state.
                    for (let lineStart = index; lineStart < limit;) {
                        let lineEnd = lineStart
                        let line = ''
                        do {
                            const newline = command.indexOf('\n', lineEnd)
                            const end = newline === -1 || newline >= limit ? limit : newline
                            let part = command.slice(lineEnd, end)
                            if (doc.stripTabs) {
                                part = part.replace(/^\t+/, '')
                            }
                            lineEnd = end < limit ? end + 1 : limit
                            const continued = doc.expand && end < limit && /(?:^|[^\\])(?:\\\\)*\\$/.test(part)
                            line += continued ? part.slice(0, -1) : part
                            if (!continued) {
                                break
                            }
                        } while (lineEnd < limit)
                        if (line === doc.delimiter) {
                            bodyEnd = lineStart
                            afterDelimiter = lineEnd
                            break
                        }
                        lineStart = lineEnd
                    }
                    index = bodyStart
                    if (doc.expand) {
                        result += scan('input', bodyEnd)
                    }
                    index = afterDelimiter
                    result += '\n'
                }
                continue
            } else {
                if (!quote && (char === '(' || char === ')')) {
                    parentheses += char === '(' ? 1 : -1
                }
                result += quote || mode === 'arithmetic' ? ' ' : char
            }
            ++index
        }
        return result
    }
    return scan('shell', command.length)
}

function hasBackgroundOperator(command: string): boolean {
    return /(?:^|[^&<>])&(?=$|[^&>])/.test(command)
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
    const executable = withoutQuotedText(command, shell).toLowerCase()
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
        if (hasBackgroundOperator(executable)) {
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
