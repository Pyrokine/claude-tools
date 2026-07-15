export type CommandRisk = {
    level: 'medium' | 'high'
    categories: string[]
    signals: string[]
    suggestion: string
}

function pushRisk(categories: Set<string>, signals: string[], category: string, signal: string): void {
    categories.add(category)
    signals.push(signal)
}

function hasBackgroundOperator(command: string): boolean {
    let quote: "'" | '"' | undefined
    let escaped = false
    for (let index = 0; index < command.length; ++index) {
        const character = command[index]
        if (escaped) {
            escaped = false
            continue
        }
        if (character === '\\' && quote !== "'") {
            escaped = true
            continue
        }
        if (quote) {
            if (character === quote) {
                quote = undefined
            }
            continue
        }
        if (character === "'" || character === '"') {
            quote = character
            continue
        }
        if (character !== '&') {
            continue
        }
        const previous = command[index - 1]
        const next = command[index + 1]
        if (previous === '&' || next === '&' || previous === '>' || previous === '<' || next === '>') {
            continue
        }
        return true
    }
    return false
}

export function classifyCommandRisk(command: string, timeout?: number): CommandRisk | undefined {
    const signals: string[] = []
    const categories = new Set<string>()
    const pipeCount = (command.match(/\|/g) ?? []).length
    const lowerCommand = command.toLowerCase()
    const background = hasBackgroundOperator(command)
    const continuous = /\b(?:tail\s+-f|journalctl\s+-f|watch|top|htop)\b/.test(command)
    const unboundedFind = /\bfind\b/.test(command) && !/\s-maxdepth\s+\d+/.test(command)
    const recursiveGrep = /\bgrep\s+(?:-\S*R|--recursive)\b/.test(command)

    if (command.length > 500) {
        pushRisk(categories, signals, 'complexity-signal', 'long_command')
    }
    if (pipeCount >= 3) {
        pushRisk(categories, signals, 'complexity-signal', 'long_pipeline')
    }
    if (recursiveGrep) {
        pushRisk(categories, signals, 'long-running', 'recursive_grep')
    }
    if (unboundedFind) {
        pushRisk(categories, signals, 'long-running', 'unbounded_find')
    }
    if (/\b(?:python|python3|node|perl|ruby)\b/.test(command)) {
        pushRisk(categories, signals, 'script-execution', 'interpreter_script')
    }
    if (/\bsleep\s+\d{2,}\b/.test(command) || continuous) {
        pushRisk(categories, signals, 'long-running', continuous ? 'continuous_command' : 'long_sleep')
    }
    if (background) {
        pushRisk(categories, signals, 'process-control', 'background_task')
    }
    const recursiveRemove = /\brm\b(?=[^\n;|&]*(?:\s-[a-z]*r[a-z]*\b|\s--recursive\b))/.test(lowerCommand)
    if (recursiveRemove || /\b(?:dd\s+if=|mkfs|fdisk|parted|shutdown|reboot)\b/.test(lowerCommand)) {
        pushRisk(categories, signals, 'destructive', 'destructive_command')
    }
    const processControl = /\b(?:pkill|killall)\b/.test(lowerCommand) || /\bkill\s+(?!-0(?:\s|$))/.test(lowerCommand)
    if (processControl) {
        pushRisk(categories, signals, 'process-control', 'process_control')
    }
    if (/\b(?:systemctl|service|docker|kubectl)\s+(?:restart|stop|kill|delete|rm|down)\b/.test(lowerCommand)) {
        pushRisk(categories, signals, 'service-control', 'service_control')
    }
    if (/\b(?:password|passwd|token|authorization|cookie|secret|private[_-]?key)\b/i.test(command)) {
        pushRisk(categories, signals, 'credential-bearing', 'credential_bearing')
    }
    if (/\bsu\s+-?\s*[a-zA-Z_][a-zA-Z0-9_-]*\s+-c\b/.test(command)) {
        pushRisk(categories, signals, 'user-switch', 'direct_su_command')
    }
    if (signals.length === 0) {
        return undefined
    }

    const boundedTimeout = timeout !== undefined && timeout > 0 && timeout <= 300_000
    const high =
        categories.has('destructive') ||
        categories.has('service-control') ||
        categories.has('process-control') ||
        continuous ||
        ((unboundedFind || recursiveGrep) && !boundedTimeout)
    return {
        level: high ? 'high' : 'medium',
        categories: Array.from(categories),
        signals,
        suggestion: signals.includes('direct_su_command')
            ? '建议使用 ssh_exec 的 runAs 参数或 ssh_exec_as_user，避免手写 su 命令造成引用和环境加载差异'
            : high
              ? '长任务使用 ssh_operation_start，交互命令使用 ssh_pty_start，破坏性操作执行前确认目标范围'
              : '如输出较大，请设置 maxOutputSize 或重定向到远端文件后分块读取',
    }
}
