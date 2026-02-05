/**
 * Логи для отладки игры. В консоли браузера:
 *   aliasLogs()     — вывести все логи и вернуть массив
 *   aliasLogs(50)   — вывести последние 50 записей
 *   aliasLogs.clear() — очистить буфер
 *   aliasLogs.last(10) — вернуть последние 10 записей (без вывода)
 */

export type LogCategory =
  | 'ws'
  | 'state'
  | 'action'
  | 'room'
  | 'team'
  | 'round'
  | 'word'
  | 'ui'
  | 'error'

export type LogEntry = {
  at: string
  cat: LogCategory
  msg: string
  data?: unknown
}

const MAX_ENTRIES = 500
const buffer: LogEntry[] = []

function now(): string {
  return new Date().toISOString().slice(11, 23)
}

export function log(cat: LogCategory, msg: string, data?: unknown): void {
  const entry: LogEntry = { at: now(), cat, msg, data }
  buffer.push(entry)
  if (buffer.length > MAX_ENTRIES) buffer.shift()
  if (typeof console !== 'undefined' && console.debug) {
    console.debug(`[alias ${entry.at}] [${cat}] ${msg}`, data ?? '')
  }
}

export function getLogs(): LogEntry[] {
  return [...buffer]
}

export function getLast(n: number): LogEntry[] {
  return buffer.slice(-n)
}

export function clearLogs(): void {
  buffer.length = 0
}

function formatEntry(e: LogEntry): string {
  const dataStr = e.data !== undefined ? ` ${JSON.stringify(e.data)}` : ''
  return `${e.at} [${e.cat}] ${e.msg}${dataStr}`
}

export function exposeToWindow(): void {
  const dump = (limit?: number) => {
    const entries = limit != null ? getLast(limit) : getLogs()
    if (entries.length === 0) {
      console.log('[aliasLogs] Логов пока нет.')
      return entries
    }
    console.log(`[aliasLogs] Всего записей: ${buffer.length}. Вывод ${entries.length}:`)
    entries.forEach((e) => console.log(formatEntry(e)))
    return entries
  }
  const api = Object.assign(dump, {
    clear: () => {
      clearLogs()
      console.log('[aliasLogs] Буфер очищен.')
    },
    last: (n: number) => getLast(n),
    get all() {
      return getLogs()
    },
  })
  ;(window as unknown as { aliasLogs: typeof api }).aliasLogs = api
  console.log('[alias] В консоли доступна команда aliasLogs(). aliasLogs() — вывод логов, aliasLogs.clear() — очистить, aliasLogs.last(n) — последние n.')
}
