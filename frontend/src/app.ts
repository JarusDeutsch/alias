import { playCorrect, playDontKnow, playLose, playSkip, playWin } from './sounds'

type PlayerRole = 'cluegiver' | 'guesser' | 'spectator'
type GameMode = 'to_words' | 'to_rounds'
type GuessOutcome = 'correct' | 'dont_know' | 'skip'

type WordPack = 'simple' | 'medium' | 'hard'

type GameConfig = {
  mode: GameMode
  round_seconds: number
  target_words: number
  max_rounds: number
  word_pack?: WordPack
}

type WordEvent = {
  word: string
  outcome: GuessOutcome
  at: string
}

type Player = {
  id: string
  name: string
  room_id: string
  role: PlayerRole
  team_id: string | null
}

type RoomTeamSummary = {
  id: string
  name: string
  code: string
  score: number
  total_correct: number
  round_number: number
  round_active: boolean
  players_count: number
  cluegiver_name?: string | null
  player_names?: string[]
}

type RoomPublicView = {
  id: string
  code: string
  name: string
  config: GameConfig
  game_over: boolean
  winner_team_id: string | null
  teams: RoomTeamSummary[]
  spectators: string[]
  custom_words_name?: string | null
}

type TeamPrivateView = {
  id: string
  name: string
  code: string
  players: Player[]
  cluegiver_id: string | null
  score: number
  total_correct: number
  round_number: number
  round_active: boolean
  round_started_at: string | null
  round_ends_at: string | null
  rounds: WordEvent[][]
  last_revealed_word: string | null
  current_word?: string | null
}

type WsView = {
  room: RoomPublicView
  me: { id: string; name: string; role: PlayerRole; team_id: string | null }
  my_team: TeamPrivateView | null
  spectator_teams?: TeamPrivateView[] | null
}

type WsState = { type: 'state'; view: WsView }
type WsError = { type: 'error'; message: string }
type WsPlayerLeft = { type: 'player_left'; player_name: string }
type WsLeft = { type: 'left' }

// В продакшене на Cloudflare: пустая строка = тот же origin (Worker на том же домене).
// Локально: не задано = localhost:8000. Или задать VITE_API_BASE при сборке.
const API_BASE =
  typeof import.meta.env.VITE_API_BASE === 'string' && import.meta.env.VITE_API_BASE !== ''
    ? import.meta.env.VITE_API_BASE.replace(/\/$/, '')
    : `${window.location.protocol}//${window.location.hostname}:8000`
const appEl = document.querySelector<HTMLDivElement>('#app')!

const PLAYER_NAME_MIN_LEN = 1
const PLAYER_NAME_MAX_LEN = 64
const ROOM_CODE_MIN_LEN = 4
const ROOM_CODE_MAX_LEN = 10
const CONFIG_ROUND_SEC_MIN = 10
const CONFIG_ROUND_SEC_MAX = 600
const CONFIG_TARGET_WORDS_MIN = 1
const CONFIG_TARGET_WORDS_MAX = 500
const CONFIG_MAX_ROUNDS_MIN = 1
const CONFIG_MAX_ROUNDS_MAX = 100

const TAGLINES = [
  'ЛЛДВМ❤️', 
  'For vibe',
  'by Jarus',
  'Йоу',
  'Шо ты?',
]
const tagline = TAGLINES[Math.floor(Math.random() * TAGLINES.length)]

let toastHideTimer: number | null = null
let toastLeaveHideTimer: number | null = null

const store = {
  roomCode: localStorage.getItem('alias_room_code') ?? '',
  teamCode: localStorage.getItem('alias_team_code') ?? '',
  playerId: localStorage.getItem('alias_player_id') ?? '',
  playerRoomCode: localStorage.getItem('alias_player_room_code') ?? '',
  playerName: localStorage.getItem('alias_player_name') ?? '',
  desiredRole: (localStorage.getItem('alias_role') as PlayerRole | null) ?? 'guesser',
  ws: null as WebSocket | null,
  view: null as WsView | null,
  connecting: false,
  nowMs: Date.now(),
  settingsDraft: null as GameConfig | null,
  settingsDirty: false,
  settingsOpen: false,
  spectatorsOpen: false,
  lobbyRoomInfo: null as RoomPublicView | null,
  reconnectAttempt: 0,
  reconnectTimerId: null as number | null,
  lobbyLoadingMessage: null as string | null,
  mobileTab: 'team' as 'team' | 'controls',
  isMobile: false,
  copiedRoomCode: null as string | null,
  copiedRoomCodeTimerId: null as number | null,
}

function showToast(message: string) {
  const el = document.getElementById('aliasToast')
  if (!el) return
  el.textContent = message
  el.classList.remove('hidden')
  if (toastHideTimer) window.clearTimeout(toastHideTimer)
  toastHideTimer = window.setTimeout(() => {
    el.classList.add('hidden')
    el.textContent = ''
  }, 1500)
}

function showToastLeave(message: string) {
  const el = document.getElementById('aliasToastLeave')
  if (!el) return
  el.textContent = message
  el.classList.remove('hidden')
  if (toastLeaveHideTimer) window.clearTimeout(toastLeaveHideTimer)
  toastLeaveHideTimer = window.setTimeout(() => {
    el.classList.add('hidden')
    el.textContent = ''
  }, 1500)
}

function save() {
  localStorage.setItem('alias_room_code', store.roomCode)
  localStorage.setItem('alias_team_code', store.teamCode)
  localStorage.setItem('alias_player_id', store.playerId)
  localStorage.setItem('alias_player_room_code', store.playerRoomCode)
  localStorage.setItem('alias_player_name', store.playerName)
  localStorage.setItem('alias_role', store.desiredRole)
}

function escapeHtml(s: string) {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

function configKey(c: GameConfig): string {
  return `${c.mode}|${c.round_seconds}|${c.target_words}|${c.max_rounds}|${c.word_pack ?? 'medium'}`
}

function parseRoomCodeFromUrl(): string | null {
  const p = window.location.pathname.replace(/^\/+|\/+$/g, '')
  if (!p) return null
  if (!/^[A-Za-z0-9]{4,10}$/.test(p)) return null
  return p.toUpperCase()
}

function validatePlayerName(name: string): string | null {
  const s = name.trim()
  if (s.length < PLAYER_NAME_MIN_LEN) return 'Введите имя'
  if (s.length > PLAYER_NAME_MAX_LEN) return `Имя не длиннее ${PLAYER_NAME_MAX_LEN} символов`
  return null
}

function validateRoomCode(code: string): string | null {
  const s = code.trim().toUpperCase()
  if (s.length < ROOM_CODE_MIN_LEN) return 'Введите код комнаты'
  if (s.length > ROOM_CODE_MAX_LEN) return `Код комнаты от ${ROOM_CODE_MIN_LEN} до ${ROOM_CODE_MAX_LEN} символов`
  if (!/^[A-Za-z0-9]+$/.test(s)) return 'Код комнаты — только латиница и цифры'
  return null
}

const API_ERROR_MESSAGES: Record<string, string> = {
  room_not_found: 'Комната не найдена',
  team_not_found: 'Команда не найдена',
  player_not_found: 'Игрок не найден',
  wrong_room: 'Неверная комната',
  team_code_required: 'Укажите код команды',
  csv_file_required: 'Нужен файл CSV',
  utf8_required: 'Файл должен быть в кодировке UTF-8',
  no_words_in_file: 'В файле нет слов',
  file_too_large: 'Файл слишком большой (макс. 512 КБ)',
  too_many_words: 'Слишком много слов (макс. 5000)',
  file_read_error: 'Не удалось прочитать файл',
}

function apiErrorMessage(detail: string): string {
  return API_ERROR_MESSAGES[detail] ?? detail
}

async function fetchJson<T>(url: string, init: RequestInit, timeoutMs = 6000): Promise<T> {
  const controller = new AbortController()
  const t = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    const text = await res.text()
    if (!res.ok) {
      let msg = text
      try {
        const j = JSON.parse(text) as { detail?: string | { msg?: string }[] }
        if (typeof j.detail === 'string') msg = j.detail
        else if (Array.isArray(j.detail) && j.detail[0]?.msg) {
          msg = String(j.detail[0].msg).replace(/^Value error,\s*/i, '')
        }
      } catch {
        // leave msg as text
      }
      throw new Error(msg)
    }
    return (text ? JSON.parse(text) : {}) as T
  } finally {
    window.clearTimeout(t)
  }
}

function card(inner: string, cls = '') {
  return `<div class="rounded-md bg-white/5 p-6 ring-1 ring-white/10 backdrop-blur ${cls}">${inner}</div>`
}

async function copyToClipboard(text: string): Promise<boolean> {
  const value = text.trim()
  if (!value) return false
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return true
    }
  } catch {
    // fallback below
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = value
    ta.setAttribute('readonly', 'true')
    ta.style.position = 'fixed'
    ta.style.left = '-9999px'
    ta.style.top = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

function canEditSettings(view: WsView | null): boolean {
  if (!view) return false
  return !!view.me.team_id && !view.room.game_over
}

function remainingSeconds(team: TeamPrivateView | null): number | null {
  if (!team || !team.round_active || !team.round_ends_at) return null
  const end = Date.parse(team.round_ends_at)
  if (Number.isNaN(end)) return null
  return Math.max(0, Math.ceil((end - store.nowMs) / 1000))
}

function remainingMs(team: TeamPrivateView | null): number | null {
  if (!team || !team.round_active || !team.round_ends_at) return null
  const end = Date.parse(team.round_ends_at)
  if (Number.isNaN(end)) return null
  return Math.max(0, end - store.nowMs)
}

function clamp01(x: number) {
  return Math.max(0, Math.min(1, x))
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function mixRgb(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  const tt = clamp01(t)
  return [Math.round(lerp(a[0], b[0], tt)), Math.round(lerp(a[1], b[1], tt)), Math.round(lerp(a[2], b[2], tt))]
}

function colorForFraction(frac: number): [number, number, number] {
  // 1.0 -> green, 0.5 -> yellow, 0.1 -> red
  const green: [number, number, number] = [34, 197, 94] // emerald-500-ish
  const yellow: [number, number, number] = [234, 179, 8] // amber-500-ish
  const red: [number, number, number] = [239, 68, 68] // red-500-ish

  const f = clamp01(frac)
  if (f >= 0.5) {
    // 0.5..1 -> yellow..green
    const t = (f - 0.5) / 0.5
    return mixRgb(yellow, green, t)
  }
  // 0..0.5 -> red..yellow, при этом к 0.1 уже почти красный
  const t = clamp01(f / 0.5)
  return mixRgb(red, yellow, t)
}

function formatMmSs(totalSeconds: number) {
  const s = Math.max(0, Math.floor(totalSeconds))
  const m = Math.floor(s / 60)
  const ss = String(s % 60).padStart(2, '0')
  return `${m}:${ss}`
}

function updateTimerTexts() {
  const team = store.view?.my_team ?? null
  const remain = remainingSeconds(team)
  const text = remain === null ? '' : `${remain}s`
  const a = document.getElementById('roundTimerValue')
  if (a) a.textContent = text
  const b = document.getElementById('roundTimerValue2')
  if (b) b.textContent = text

  // Global big timer (top of game screen)
  const wrap = document.getElementById('globalTimerWrap')
  const digits = document.getElementById('globalTimerDigits')
  const bar = document.getElementById('globalTimerBarInner') as HTMLDivElement | null
  const ms = remainingMs(team)
  if (!wrap || !digits || !bar || !store.view) return

  if (ms === null) {
    wrap.classList.add('hidden')
    wrap.classList.remove('alias-timer-red')
    bar.style.width = '0%'
    bar.style.backgroundImage = ''
    digits.textContent = ''
    return
  }

  const totalMs = Math.max(1, (store.view.room.config?.round_seconds ?? 60) * 1000)
  const frac = clamp01(ms / totalMs)
  const pct = frac * 100

  const [r, g, bl] = colorForFraction(frac)
  const lighter: [number, number, number] = [Math.min(255, r + 24), Math.min(255, g + 24), Math.min(255, bl + 24)]
  const darker: [number, number, number] = [Math.max(0, r - 18), Math.max(0, g - 18), Math.max(0, bl - 18)]

  bar.style.width = `${pct.toFixed(3)}%`
  bar.style.backgroundImage = `linear-gradient(90deg, rgb(${lighter[0]} ${lighter[1]} ${lighter[2]}), rgb(${darker[0]} ${darker[1]} ${darker[2]}))`

  // big white digits
  digits.textContent = formatMmSs(Math.ceil(ms / 1000))

  // "red tone" mode when <=10% time left, and reset back when round ends
  const isRed = frac <= 0.1 && frac > 0
  wrap.classList.toggle('alias-timer-red', isRed)
  wrap.classList.remove('hidden')
}

function render() {
  const view = store.view
  const connected = store.ws?.readyState === WebSocket.OPEN
  const connecting = store.connecting && !connected

  const gameStartedForHeader = view && (view.room.teams ?? []).some((t) => t.round_number > 0) && !view.room.game_over
  const spectatorsPanel = view
      ? (() => {
          const spectators = view.room.spectators ?? []
          const content = `
            <div class="text-base text-slate-400">Игроки без команды</div>
            <div class="mt-2 flex flex-wrap gap-2">
              ${spectators.length ? spectators.map((n) => `<span class="rounded-full bg-white/10 px-2 py-1 text-base text-slate-200 ring-1 ring-white/10">${escapeHtml(n)}</span>`).join('') : '<span class="text-base text-slate-500">пока никого</span>'}
            </div>`
          if (gameStartedForHeader) {
            return `<div class="rounded-md bg-white/5 p-3 ring-1 ring-white/10 min-w-[160px]">${content}</div>`
          }
          return `<button type="button" class="becomeSpectatorBtn rounded-md bg-white/5 p-3 ring-1 ring-white/10 min-w-[160px] text-left hover:bg-white/10 hover:ring-white/20 focus:outline-none focus:ring-2 focus:ring-indigo-500/60 cursor-pointer transition-colors" title="Нажмите, чтобы выйти в игроки без команды">${content}</button>`
        })()
      : ''

  const reconnectBtn =
    view && store.playerId && !connected && !connecting
      ? `<button id="reconnectBtn" type="button" class="ml-2 rounded-md bg-sky-500/80 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-400">Переподключиться</button>`
      : ''
  const header = `
    <div class="flex items-center justify-between gap-3">
      <div>
        <div class="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-0.5 text-sm text-slate-200 ring-1 ring-white/10">
          <span class="h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : connecting ? 'bg-sky-400' : 'bg-amber-400'}"></span>
          <span>${connected ? 'Подключено' : connecting ? 'Подключаемся…' : 'Не подключено'}</span>
          ${reconnectBtn}
        </div>
        <h1 class="mt-2 text-3xl font-semibold tracking-tight">Alias Web</h1>
        <p class="mt-1 text-base text-slate-300">${escapeHtml(tagline)}</p>
      </div>
      ${spectatorsPanel}
    </div>
  `

  const body = view ? renderGameLayout(view) : renderLobbyLayout()

  const gameStartedForPack = view && (view.room.teams ?? []).some((t) => t.round_number > 0) && !view.room.game_over
  const canChangeWordPackBtn = view && store.playerRoomCode && !gameStartedForPack
  const wordsUploadEl =
    view && store.playerRoomCode
      ? `
    <div class="fixed bottom-4 right-4 z-40">
      <input type="file" id="wordsCsvInput" accept=".csv" class="hidden" />
      <button type="button" id="uploadWordsBtn" title="${!canChangeWordPackBtn ? 'Пак слов нельзя менять после начала первого раунда до конца игры' : view.room.custom_words_name ? 'Пак слов загружен' : 'Загрузить пак слов из CSV для этой комнаты'}"
        class="rounded-md bg-white/10 px-3 py-2 text-sm font-medium text-slate-200 ring-1 ring-white/10 hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-indigo-500/60 disabled:opacity-50 disabled:cursor-not-allowed"
        ${canChangeWordPackBtn ? '' : 'disabled'}>
        ${escapeHtml(view.room.custom_words_name ?? 'Загрузить пак слов')}
      </button>
    </div>`
      : ''

  const mainContent = `
    <div class="alias-page-bg min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 text-slate-100">
      <div class="relative z-10 mx-auto max-w-[1520px] px-4 py-8">
        <div id="aliasHeaderWrap">${header}</div>
        <div id="aliasBodyWrap" class="alias-divider mt-8 pt-8">${body}</div>
      </div>
    </div>
    ${wordsUploadEl}
  `

  let mainEl = document.getElementById('aliasMain')
  if (!mainEl) {
    appEl.innerHTML = `
    <div id="aliasMain"></div>
    <div id="aliasToast" class="pointer-events-none fixed bottom-4 left-1/2 z-50 hidden -translate-x-1/2 rounded-md bg-slate-950/80 px-3 py-1.5 text-sm text-white ring-1 ring-white/10 backdrop-blur">toast</div>
    <div id="aliasToastLeave" class="pointer-events-none fixed bottom-4 left-1/2 z-50 hidden -translate-x-1/2 rounded-md bg-rose-600/95 px-3 py-1.5 text-sm text-white ring-1 ring-rose-400/30 backdrop-blur">leave</div>
    `
    mainEl = document.getElementById('aliasMain')!
  }

  // На экране лобби при повторном render() обновляем только шапку (статус), чтобы не затирать поля ввода
  if (!view && document.getElementById('roomCode')) {
    const headerWrap = document.getElementById('aliasHeaderWrap')
    if (headerWrap) headerWrap.innerHTML = header
    return
  }

  mainEl.innerHTML = mainContent
  wireHandlers()
}

function renderLobbyLayout() {
  return `
    <div class="grid gap-8 lg:grid-cols-2">
      ${card(renderLobbyCard())}
      ${card(renderHelpCard())}
    </div>
  `
}

function renderLobbyCard() {
  const roomCodeFromUrl = parseRoomCodeFromUrl()
  const fromUrl = roomCodeFromUrl !== null && store.roomCode.trim().toUpperCase() === roomCodeFromUrl
  const codeDisplay = escapeHtml(store.roomCode.trim().toUpperCase() || roomCodeFromUrl || '')

  return `
    <h2 class="text-lg font-semibold">Лобби</h2>
    <p class="mt-1 text-base text-slate-300">Выберите ник и создайте комнату или войдите по номеру</p>

    <div class="mt-5 grid gap-3">
      <label class="grid gap-1">
        <span class="text-base text-slate-300">Ваше имя</span>
        <input id="playerName" value="${escapeHtml(store.playerName)}" placeholder="Например, Даша" maxlength="${PLAYER_NAME_MAX_LEN}"
          class="rounded-md bg-white/5 px-2.5 py-1.5 text-sm ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-500/60" />
      </label>

      <label class="grid gap-1">
        <span class="text-base text-slate-300">Номер (код) комнаты</span>
        <input id="roomCode" value="${escapeHtml(store.roomCode)}" placeholder="Например, 8K3QZP" maxlength="${ROOM_CODE_MAX_LEN}"
          class="rounded-md bg-white/5 px-2.5 py-1.5 text-sm uppercase tracking-widest ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-500/60" />
      </label>

      ${
        fromUrl && codeDisplay
          ? `
      <div class="mt-1 rounded-md bg-emerald-500/15 p-4 ring-2 ring-emerald-500/40">
        <p class="text-base font-medium text-emerald-100">Вас пригласили в комнату</p>
        <button id="enterRoom" type="button" class="mt-3 w-full rounded-md bg-emerald-500 px-5 py-3.5 text-lg font-semibold text-emerald-950 hover:bg-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-slate-900">
          Войти в комнату /${codeDisplay}
        </button>
      </div>
      <div class="mt-1">
        <button id="createRoom" class="min-w-[10.5rem] rounded-md bg-white/10 px-4 py-2 text-sm font-semibold text-slate-200 ring-1 ring-white/10 hover:bg-white/15">
          Создать свою комнату
        </button>
      </div>`
          : `
      <div class="mt-1 grid gap-2 sm:grid-cols-2">
        <button id="createRoom" class="min-w-[10.5rem] rounded-md bg-indigo-500 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-400">
          Создать комнату
        </button>
        <button id="enterRoom" class="min-w-[10.5rem] rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-50" ${store.roomCode.trim() ? '' : 'disabled'}>
          Войти по коду
        </button>
      </div>`
      }

      <div id="lobbyRoomCodeRow">${
        store.roomCode
          ? `<div class="flex flex-wrap items-center gap-2 text-base text-slate-400">
              <span>Комната:</span>
              <button
                type="button"
                class="copyRoomCode inline-flex items-center gap-1 font-mono tracking-widest underline decoration-dotted underline-offset-4 hover:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/60 ${store.copiedRoomCode === store.roomCode.trim().toUpperCase() ? 'text-emerald-400' : 'text-slate-200'}"
                title="Нажмите, чтобы скопировать код комнаты"
                data-roomcode="${escapeHtml(store.roomCode)}"
              >${store.copiedRoomCode === store.roomCode.trim().toUpperCase() ? 'Скопировано ✓' : `/${escapeHtml(store.roomCode)}`}</button>
              <button id="loadRoom" type="button" class="rounded-md bg-white/10 px-2 py-1 text-sm text-slate-300 hover:bg-white/15">Обновить</button>
            </div>`
          : `<div class="text-base text-slate-400"></div>`
      }</div>

      ${store.lobbyLoadingMessage ? `<div id="lobbyStatus" class="rounded-md bg-white/5 px-3 py-2 text-base text-slate-300 ring-1 ring-white/10 flex items-center gap-2"><span class="alias-spinner"></span><span>${escapeHtml(store.lobbyLoadingMessage)}</span></div>` : '<div id="lobbyStatus" class="hidden rounded-md bg-white/5 px-3 py-2 text-base text-slate-300 ring-1 ring-white/10"></div>'}
      <div id="lobbyError" class="hidden rounded-md bg-rose-500/10 px-3 py-2 text-base text-rose-200 ring-1 ring-rose-500/20 mt-2"></div>
    </div>
  `
}

function renderHelpCard() {
  return `
    <h2 class="text-lg font-semibold">Правила игры</h2>
    <ul class="mt-4 grid gap-2 text-base text-slate-300">
      <li class="rounded-md bg-white/5 px-3 py-2 ring-1 ring-white/10">
        <span class="font-semibold text-slate-100">Роли.</span> В команде — загадывающий и угадывающие.<br>
        Загадывающий видит слово и объясняет его без названия.<br>
        Угадывающие называют слово.
      </li>
      <li class="rounded-md bg-white/5 px-3 py-2 ring-1 ring-white/10">
        <span class="font-semibold text-slate-100">Очки.</span> Угадал +1, не знаю 0, пропуск −1.
      </li>
      <li class="rounded-md bg-white/5 px-3 py-2 ring-1 ring-white/10">
        <span class="font-semibold text-slate-100">Победа.</span> По настройкам — либо «первый до N слов», либо «N раундов, у кого больше очков».
      </li>
      <li class="rounded-md bg-white/5 px-3 py-2 ring-1 ring-white/10">
        <span class="font-semibold text-slate-100">Последнее слово.</span> После конца таймера слово угадывающему не показывают.<br>
        Раунд заканчивается, когда загадывающий отметит его (Угадал / Не знаю / Пропуск).
      </li>
    </ul>
  `
}

function renderGlobalTimer(view: WsView) {
  const team = view.my_team
  const ms = remainingMs(team ?? null)
  const active = ms !== null
  let barStyle = ''
  let wrapClass = active ? '' : 'hidden '
  if (active && ms != null) {
    const totalMs = Math.max(1, (view.room.config?.round_seconds ?? 60) * 1000)
    const frac = clamp01(ms / totalMs)
    const pct = frac * 100
    const [r, g, bl] = colorForFraction(frac)
    const lighter: [number, number, number] = [Math.min(255, r + 24), Math.min(255, g + 24), Math.min(255, bl + 24)]
    const darker: [number, number, number] = [Math.max(0, r - 18), Math.max(0, g - 18), Math.max(0, bl - 18)]
    barStyle = `width:${pct.toFixed(3)}%;background-image:linear-gradient(90deg, rgb(${lighter[0]} ${lighter[1]} ${lighter[2]}), rgb(${darker[0]} ${darker[1]} ${darker[2]}));`
    if (frac <= 0.1 && frac > 0) wrapClass += 'alias-timer-red '
  }
  wrapClass += 'mt-6'
  return `
    <div id="globalTimerWrap" class="${wrapClass}">
      <div class="-mx-3">
        <div class="alias-timer-bar-outer h-1.5 w-full overflow-hidden">
          <div id="globalTimerBarInner" class="alias-timer-bar-inner h-full" style="${barStyle}"></div>
        </div>
      </div>
      <div class="mt-3 text-center">
        <div id="globalTimerDigits" class="alias-timer-digits text-5xl font-semibold text-white sm:text-6xl">${active ? formatMmSs(Math.ceil((ms ?? 0) / 1000)) : ''}</div>
      </div>
    </div>
  `
}

function renderGameLayout(view: WsView) {
  const top = renderTopBar(view)
  const left = card(renderMyTeamPanel(view), 'h-fit lg:w-[280px] lg:justify-self-end')
  const center = card(renderCenterPanel(view), 'min-h-[540px] w-full lg:justify-self-center')
  const right = card(renderRightPanel(view), 'h-fit lg:w-[440px] lg:justify-self-start')
  const mobileTab = store.mobileTab
  const isMobile = store.isMobile
  return `
    ${renderGlobalTimer(view)}
    ${top}
    <div class="mt-6 grid gap-6 lg:grid-cols-[1fr_minmax(0,960px)_1fr]">
      ${!isMobile ? `<div>${left}</div>` : ''}
      <div>${center}</div>
      ${!isMobile ? `<div>${right}</div>` : ''}
      ${isMobile ? `
      <div class="alias-mobile-tabs min-w-0">
        <div class="flex gap-2 border-b border-white/10 pb-2">
          <button type="button" class="alias-mobile-tab rounded-md px-4 py-2.5 text-sm font-semibold transition-colors ${mobileTab === 'team' ? 'bg-white/15 text-white ring-1 ring-white/20' : 'bg-white/5 text-slate-400 ring-1 ring-white/10 hover:bg-white/10'}" data-tab="team">Команда</button>
          <button type="button" class="alias-mobile-tab rounded-md px-4 py-2.5 text-sm font-semibold transition-colors ${mobileTab === 'controls' ? 'bg-white/15 text-white ring-1 ring-white/20' : 'bg-white/5 text-slate-400 ring-1 ring-white/10 hover:bg-white/10'}" data-tab="controls">Управление</button>
        </div>
        <div class="alias-mobile-panel mt-3 min-w-0">${mobileTab === 'team' ? left : right}</div>
      </div>
      ` : ''}
    </div>
  `
}

function renderTopBar(view: WsView) {
  const teamsList = view.room.teams ?? []
  const gameStarted = teamsList.some((t) => t.round_number > 0) && !view.room.game_over
  const teams = teamsList
    .map((t) => {
      const winner = view.room.winner_team_id === t.id
      const playerNames = (t.player_names ?? []).length
        ? (t.player_names ?? []).map((n) => `<span class="rounded-full bg-white/10 px-2 py-0.5 text-sm text-slate-200 ring-1 ring-white/10">${escapeHtml(n)}</span>`).join('')
        : '<span class="text-sm text-slate-500">пока никого</span>'
      const base = `
        <div class="min-w-0 flex-1">
          <div class="truncate text-base font-medium text-slate-100">${escapeHtml(t.name)}</div>
          <div class="text-base text-slate-400">раунд ${t.round_number}${t.round_active ? ' (идёт)' : ''}</div>
          <div class="mt-1.5 flex flex-wrap gap-1">${playerNames}</div>
        </div>
        <div class="ml-auto shrink-0 text-right">
          <div class="text-base font-semibold ${winner ? 'text-emerald-200' : 'text-slate-100'}">${t.score}</div>
          <div class="text-base text-slate-400">${t.total_correct} слов</div>
        </div>`
      if (gameStarted) {
        return `<div class="flex items-start gap-2 rounded-md bg-white/5 px-2.5 py-1.5 ring-1 ring-white/10">${base}</div>`
      }
      return `<div role="button" tabindex="0" data-teamcode="${escapeHtml(t.code)}" class="joinTeamBtn flex w-full cursor-pointer items-start gap-2 rounded-md bg-white/5 px-2.5 py-1.5 text-left ring-1 ring-white/10 transition-colors hover:bg-white/10 hover:ring-white/20 focus:outline-none focus:ring-2 focus:ring-indigo-500/60" title="Нажмите, чтобы вступить в команду">${base}</div>`
    })
    .join('')

  return `
    <div class="mt-10">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-2 text-base text-slate-300">
          <button id="leaveRoom" title="Выйти из комнаты"
            class="inline-flex h-8 w-8 items-center justify-center rounded-md bg-rose-500/90 text-white ring-1 ring-rose-500/30 hover:bg-rose-400">
            <svg viewBox="0 0 24 24" class="h-4 w-4" style="transform: scaleX(-1)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 17l5-5-5-5" />
              <path d="M15 12H3" />
              <path d="M21 5v14a2 2 0 0 1-2 2h-6" />
              <path d="M13 3h6a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          <div>
            Комната
            <button
              type="button"
              class="copyRoomCode ml-1 inline-flex items-center gap-1 font-mono tracking-widest underline decoration-dotted underline-offset-4 hover:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/60 ${store.copiedRoomCode === view.room.code ? 'text-emerald-400' : 'text-slate-100'}"
              title="Нажмите, чтобы скопировать код комнаты"
              data-roomcode="${escapeHtml(view.room.code)}"
            >${store.copiedRoomCode === view.room.code ? 'Скопировано ✓' : `/${escapeHtml(view.room.code)}`}</button>
          </div>
        </div>
      </div>
      <div class="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        ${teams}
      </div>
    </div>
  `
}

function renderTeamChooser(view: WsView) {
  const teams = view.room.teams ?? []
  const gameStarted = teams.some((t) => t.round_number > 0) && !view.room.game_over
  const teamBtnClass = gameStarted
    ? 'joinTeamBtn flex items-center justify-between gap-2 rounded-md bg-white/5 px-3 py-2 text-base ring-1 ring-white/10 cursor-not-allowed opacity-60'
    : 'joinTeamBtn flex items-center justify-between gap-2 rounded-md bg-white/5 px-3 py-2 text-base ring-1 ring-white/10 hover:bg-white/10 cursor-pointer'
  const teamButtons = teams
    .map(
      (t) => `<button data-teamcode="${escapeHtml(t.code)}" class="${teamBtnClass}" ${gameStarted ? 'disabled' : ''}>
        <span class="truncate">${escapeHtml(t.name)}</span>
        <span class="shrink-0 text-base text-slate-400">${t.players_count}</span>
      </button>`,
    )
    .join('')

  const plus = `
    <button id="addTeamBtn" title="Создать команду (+) и вступить"
      class="inline-flex h-10 w-10 items-center justify-center rounded-md bg-emerald-500 text-xl font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-50"
      ${store.playerId ? '' : 'disabled'}>
      +
    </button>
  `

  return `
    <div class="mt-4 grid gap-2">
      <div class="text-base text-slate-400">Создайте команды кнопкой “+”. Нажатие “+” сразу присоединяет вас к созданной команде.</div>
      <div class="grid gap-2">
        ${teamButtons || '<div class="text-base text-slate-300">Пока команд нет.</div>'}
      </div>
      <div class="mt-1 flex items-center gap-2">
        ${plus}
        ${teams.length ? '<div class="text-base text-slate-400">…и можно создать следующую</div>' : ''}
      </div>
    </div>
  `
}

function renderMyTeamPanel(view: WsView) {
  if (!view.me.team_id) {
    return `
      <div class="flex items-start justify-between gap-2">
        <div>
          <div class="text-base font-semibold">Команды</div>
          <div class="mt-1 text-base text-slate-400">Вы в комнате, но пока без команды.</div>
        </div>
      </div>
      ${renderTeamChooser(view)}
      <div id="teamError" class="mt-3 hidden rounded-md bg-rose-500/10 px-3 py-2 text-base text-rose-200 ring-1 ring-rose-500/20"></div>
    `
  }

  const team = view.my_team
  if (!team) return `<div class="text-base text-slate-300">Нет команды</div>`

  const isCluegiver = view.me.role === 'cluegiver' && team.cluegiver_id === view.me.id
  const gameStarted = (view.room.teams ?? []).some((t) => t.round_number > 0) && !view.room.game_over
  const roleDisabled = gameStarted
  const roleBadge = isCluegiver
    ? '<span class="rounded-full bg-indigo-500/20 px-2 py-1 text-base text-indigo-200 ring-1 ring-indigo-500/30">загад.</span>'
    : '<span class="rounded-full bg-white/10 px-2 py-1 text-base text-slate-200 ring-1 ring-white/10">угадыв.</span>'

  const players = team.players
    .map((p) => {
      const isClue = team.cluegiver_id === p.id
      return `<div class="flex items-center justify-between gap-2 rounded-md bg-white/5 px-3 py-2 ring-1 ring-white/10">
        <div class="min-w-0">
          <div class="truncate text-base font-medium text-slate-100">${escapeHtml(p.name)}</div>
          <div class="text-base text-slate-400">${p.role === 'cluegiver' ? 'загад.' : 'угадыв.'}</div>
        </div>
        ${isClue ? '<span class="shrink-0 rounded-full bg-indigo-500/20 px-2 py-1 text-base text-indigo-200 ring-1 ring-indigo-500/30">загад.</span>' : ''}
      </div>`
    })
    .join('')

  return `
    <div class="flex items-start justify-between gap-2">
      <div>
        <div class="text-base font-semibold">${escapeHtml(team.name)}</div>
      </div>
    </div>
    <div class="mt-3 grid gap-2">
      <div class="text-base text-slate-300">Ваша роль: ${roleBadge}</div>
      <button id="toggleRoleBtn" title="${roleDisabled ? 'После старта первого раунда роль менять нельзя' : ''}"
        class="w-full rounded-md bg-white/10 px-3 py-2 text-base font-semibold text-white ring-1 ring-white/10 hover:bg-white/15 disabled:opacity-50"
        ${roleDisabled ? 'disabled' : ''}>
        ${isCluegiver ? 'Стать угадывающим' : 'Стать загадывающим'}
      </button>
    </div>
    <div class="mt-4 grid gap-2">
      <div class="text-base text-slate-400">Игроки</div>
      ${players || '<div class="text-base text-slate-300">Пока никого нет…</div>'}
    </div>
    <div id="teamError" class="mt-3 hidden rounded-md bg-rose-500/10 px-3 py-2 text-base text-rose-200 ring-1 ring-rose-500/20"></div>
  `
}

function renderCenterPanel(view: WsView) {
  if (view.room.game_over) {
    const teams = view.room.teams ?? []
    const winner = teams.find((t) => t.id === view.room.winner_team_id)
    const canRestart = view.me.role === 'cluegiver' && !!view.me.team_id
    const teamsList = teams
      .map((t) => {
        const isWinner = t.id === view.room.winner_team_id
        const names = t.player_names ?? []
        const namesHtml = names.length
          ? names.map((n) => `<span class="rounded-full bg-white/10 px-2 py-0.5 text-sm text-slate-200 ring-1 ring-white/10">${escapeHtml(n)}</span>`).join('')
          : '<span class="text-sm text-slate-500">—</span>'
        return `<div class="rounded-md px-4 py-3 ring-1 ${isWinner ? 'bg-emerald-500/15 ring-emerald-500/30' : 'bg-white/5 ring-white/10'}">
          <div class="flex items-center justify-between gap-4">
            <span class="text-base font-medium ${isWinner ? 'text-emerald-100' : 'text-slate-300'}">${escapeHtml(t.name)}</span>
            <span class="text-lg font-semibold tabular-nums ${isWinner ? 'text-emerald-50' : 'text-slate-200'}">${t.score}</span>
          </div>
          <div class="mt-2 flex flex-wrap gap-1.5">${namesHtml}</div>
        </div>`
      })
      .join('')
    const confettiColors = ['bg-emerald-400', 'bg-amber-400', 'bg-rose-400', 'bg-sky-400', 'bg-violet-400']
    const confettiPieces = Array.from({ length: 12 }, (_, i) => {
      const color = confettiColors[i % confettiColors.length]
      const left = 10 + (i * 7) % 80
      const delay = (i * 0.08) + 0.2
      return `<span class="alias-confetti-piece absolute h-2 w-1 rounded-full opacity-90 ${color}" style="left:${left}%; animation-delay:${delay}s"></span>`
    }).join('')
    return `
      <div class="alias-game-over-wrap text-base text-slate-300">Игра завершена</div>
      <div class="alias-game-over-confetti relative mt-3 overflow-hidden rounded-md bg-emerald-500/10 py-6 px-5 ring-2 ring-emerald-500/30">
        <div class="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">${confettiPieces}</div>
        <div class="relative">
          <div class="text-center text-sm font-medium text-emerald-200/90">Победитель</div>
          <div class="alias-game-over-winner mt-2 text-center text-4xl font-bold tracking-tight text-emerald-50 drop-shadow-[0_0_20px_rgba(16,185,129,0.4)] sm:text-5xl">${escapeHtml(winner?.name ?? '—')}</div>
          <div class="mt-5 grid gap-2">${teamsList}</div>
        </div>
      </div>
      ${
        canRestart
          ? `<button id="restartGame" class="mt-5 w-full rounded-md bg-white/10 px-4 py-3 text-base font-semibold text-white ring-1 ring-white/10 hover:bg-white/15 transition-opacity">
              Перезапустить игру
            </button>`
          : ''
      }
    `
  }

  if (!view.me.team_id) {
    return `
      <div class="text-base font-semibold">Игровой экран</div>
      <div class="mt-1 text-base text-slate-300">Выберите команду или создайте её кнопкой “+”.</div>
      <div class="mt-6 rounded-md bg-white/5 p-7 ring-1 ring-white/10">
        <div class="text-base text-slate-300">Поля угадывания</div>
        <div class="mt-3 text-base text-slate-400">Пока пусто — вы ещё не в команде.</div>
      </div>
    `
  }

  const team = view.my_team
  if (!team) return `<div class="text-base text-slate-300">Нет данных команды</div>`

  const remain = remainingSeconds(team)
  const timeExpired = remain !== null && remain <= 0
  const timer =
    remain === null
      ? `<div class="text-base text-slate-400">Раунд не идёт</div>`
      : `<div class="text-base text-slate-300">Раунд ${team.round_number} • осталось <span id="roundTimerValue" class="font-semibold text-slate-100">${remain}s</span></div>`

  const isCluegiver = view.me.role === 'cluegiver' && team.cluegiver_id === view.me.id

  if (isCluegiver) {
    const currentWord = team.current_word ?? '…'
    const lastWordHint = timeExpired ? '<div class="mt-2 text-base text-amber-200/90">Время вышло. Отметьте последнее слово (Угадал / Не знаю / Пропуск).</div>' : ''
    return `
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="text-base text-slate-300">Вы — загадывающий</div>
          ${timer}
          ${lastWordHint}
        </div>
        <div class="text-base text-slate-300">Счёт: <span class="font-semibold text-slate-100">${team.score}</span></div>
      </div>

      <div class="mt-6 rounded-2xl bg-gradient-to-b from-white/15 via-white/5 to-slate-900/60 p-7 ring-1 ring-white/15 shadow-xl shadow-black/40 flex flex-col min-h-[220px] sm:min-h-[260px]">
        <div class="text-sm font-medium uppercase tracking-[0.18em] text-slate-300/80">Текущее слово</div>
        <div class="mt-4 flex flex-1 items-center justify-center">
          <div class="text-center text-5xl sm:text-6xl font-semibold tracking-tight text-white">${escapeHtml(currentWord)}</div>
        </div>
      </div>

      <div class="mt-5 alias-outcome-buttons rounded-md p-3 ring-1 ring-white/10 ${timeExpired ? 'alias-outcome-buttons-expired' : ''}">
        <div class="grid gap-3 sm:grid-cols-3">
          <button id="markCorrect" class="rounded-md bg-emerald-500 px-4 py-3 text-base font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-50" ${
          team.round_active ? '' : 'disabled'
        } title="Клавиша 1">
            Угадал (+1)
          </button>
          <button id="markDontKnow" class="rounded-md bg-white/10 px-4 py-3 text-base font-semibold text-white ring-1 ring-white/10 hover:bg-white/15 disabled:opacity-50" ${
          team.round_active ? '' : 'disabled'
        } title="Клавиша 2">
            Не знаю (0)
          </button>
          <button id="markSkip" class="rounded-md bg-rose-500/90 px-4 py-3 text-base font-semibold text-white hover:bg-rose-400 disabled:opacity-50" ${
          team.round_active ? '' : 'disabled'
        } title="Клавиша 3">
            Пропуск (-1)
          </button>
        </div>
      </div>
      <p class="mt-2 text-center text-sm text-slate-500">Клавиши 1, 2, 3 — быстрые действия</p>

      <div class="mt-4 rounded-md bg-white/5 px-3 py-2 text-base text-slate-300 ring-1 ring-white/10">
        Последнее показанное угадывающим: <span class="font-semibold text-slate-100">${escapeHtml(team.last_revealed_word ?? '—')}</span>
      </div>

      <div id="gameError" class="mt-3 hidden rounded-md bg-rose-500/10 px-3 py-2 text-base text-rose-200 ring-1 ring-rose-500/20"></div>
    `
  }

  const guesserTimerExpiredHint = timeExpired ? '<div class="mt-2 text-base text-amber-200/90">Время вышло. Ожидайте отметки последнего слова загадывающим.</div>' : ''
  return `
    <div class="text-base text-slate-300">Вы — угадывающий</div>
    ${timer}
    ${guesserTimerExpiredHint}
    <div class="mt-6 rounded-md bg-white/5 p-7 ring-1 ring-white/10">
      <div class="text-base text-slate-300">История слов (текущий раунд)</div>
      <div class="mt-3 max-h-[510px] overflow-y-auto pr-1">
        ${renderRoundHistory(team, true, !team.round_active)}
      </div>
    </div>
    <div id="gameError" class="mt-3 hidden rounded-md bg-rose-500/10 px-3 py-2 text-base text-rose-200 ring-1 ring-rose-500/20"></div>
  `
}

function renderRightPanel(view: WsView) {
  const canSettings = canEditSettings(view)
  const cfg = store.settingsDraft ?? view.room.config
  const team = view.my_team
  const remain = remainingSeconds(team ?? null)
  const gameStarted = (view.room.teams ?? []).some((t) => t.round_number > 0) && !view.room.game_over

  const dice = `
    <button id="randomizeBtn" title="Рандомно распределить игроков по командам и ролям"
      class="inline-flex h-9 w-9 items-center justify-center rounded-md bg-white/10 text-white ring-1 ring-white/10 hover:bg-white/15 disabled:opacity-40"
      ${view.room.teams?.length && !gameStarted ? '' : 'disabled'}>
      <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M16 3h5v5" />
        <path d="M4 20L21 3" />
        <path d="M21 16v5h-5" />
        <path d="M15 15l6 6" />
        <path d="M4 4l5 5" />
      </svg>
    </button>
  `

  const gear = `
    <button id="toggleSettings" class="rounded-md bg-white/10 px-3 py-2 text-base font-semibold text-white ring-1 ring-white/10 hover:bg-white/15">
      <span class="inline-flex items-center gap-2">
        <svg viewBox="0 0 24 24" class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" />
          <path d="M19.4 15a7.97 7.97 0 0 0 .1-1 7.97 7.97 0 0 0-.1-1l2.1-1.6-2-3.4-2.5 1a7.6 7.6 0 0 0-1.7-1L13 2h-4l-.4 2.9a7.6 7.6 0 0 0-1.7 1l-2.5-1-2 3.4L4.6 11a7.97 7.97 0 0 0-.1 1 7.97 7.97 0 0 0 .1 1L2.5 14.6l2 3.4 2.5-1a7.6 7.6 0 0 0 1.7 1L9 22h4l.4-2.9a7.6 7.6 0 0 0 1.7-1l2.5 1 2-3.4L19.4 15Z" />
        </svg>
        Настройки
      </span>
    </button>
  `

  const canChangeWordPack = !gameStarted
  const hasCustomPack = !!view.room.custom_words_name
  const wordPackSelect =
    hasCustomPack
      ? `<div class="grid gap-1">
          <span class="text-base text-slate-300">Пак слов</span>
          <div class="rounded-md bg-white/5 px-3 py-2 text-base text-slate-200 ring-1 ring-white/10">Свой: ${escapeHtml(view.room.custom_words_name ?? '')}</div>
        </div>`
      : `
        <label class="grid gap-1">
          <span class="text-base text-slate-300">Пак слов</span>
          <select id="cfgWordPack" class="rounded-md bg-white/5 px-3 py-2 text-base ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-500/60" ${canSettings && canChangeWordPack ? '' : 'disabled'} title="${!canChangeWordPack ? 'Пак слов нельзя менять после начала первого раунда до конца игры' : ''}">
            <option value="simple" ${(cfg.word_pack ?? 'medium') === 'simple' ? 'selected' : ''}>Простые</option>
            <option value="medium" ${(cfg.word_pack ?? 'medium') === 'medium' ? 'selected' : ''}>Средние</option>
            <option value="hard" ${(cfg.word_pack ?? 'medium') === 'hard' ? 'selected' : ''}>Сложные</option>
          </select>
        </label>`

  const canRestartInGame = view.me.role === 'cluegiver' && !!view.me.team_id
  const restartInSettingsBtn =
    canRestartInGame
      ? `<button id="restartGameInSettings" type="button" class="mt-3 w-full rounded-md bg-amber-500/20 px-4 py-3 text-base font-semibold text-amber-200 ring-1 ring-amber-500/30 hover:bg-amber-500/30">
          Перезапустить игру
        </button>`
      : ''

  const settings =
    store.settingsOpen
      ? `
      <div class="mt-4 grid gap-3">
        ${wordPackSelect}

        <label class="grid gap-1">
          <span class="text-base text-slate-300">Тип победы</span>
          <select id="cfgMode" class="rounded-md bg-white/5 px-3 py-2 text-base ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-500/60" ${
              canSettings ? '' : 'disabled'
            }>
              <option value="to_words" ${cfg.mode === 'to_words' ? 'selected' : ''}>По количеству угаданных слов</option>
              <option value="to_rounds" ${cfg.mode === 'to_rounds' ? 'selected' : ''}>По количеству раундов</option>
            </select>
        </label>

        <div class="grid gap-3 sm:grid-cols-2">
          <label class="grid gap-1">
            <span class="text-base text-slate-300">Время раунда (сек)</span>
            <input id="cfgRoundSec" type="number" min="${CONFIG_ROUND_SEC_MIN}" max="${CONFIG_ROUND_SEC_MAX}" value="${cfg.round_seconds}"
              class="rounded-md bg-white/5 px-3 py-2 text-base ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-500/60" ${canSettings ? '' : 'disabled'} />
          </label>
          <label class="grid gap-1">
            <span id="cfgTargetLabel" class="text-base text-slate-300">${cfg.mode === 'to_words' ? 'Слов для победы' : 'Раундов до победы'}</span>
            <input id="cfgTarget" type="number" min="${cfg.mode === 'to_words' ? CONFIG_TARGET_WORDS_MIN : CONFIG_MAX_ROUNDS_MIN}" max="${cfg.mode === 'to_words' ? CONFIG_TARGET_WORDS_MAX : CONFIG_MAX_ROUNDS_MAX}" value="${cfg.mode === 'to_words' ? cfg.target_words : cfg.max_rounds}"
              class="rounded-md bg-white/5 px-3 py-2 text-base ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-500/60" ${canSettings ? '' : 'disabled'} />
            </label>
          </div>
        ${restartInSettingsBtn}
      </div>
    `
      : ''

  const controls =
    view.me.role === 'cluegiver' && view.me.team_id
      ? `
      <div class="mt-4 grid gap-3 sm:grid-cols-2">
        <button id="startRound" class="rounded-md bg-indigo-500 px-4 py-3 text-base font-semibold text-white hover:bg-indigo-400 disabled:opacity-50" ${
          team && !team.round_active && !view.room.game_over ? '' : 'disabled'
        }>
          Старт раунда
        </button>
        <button id="endRound" class="rounded-md bg-rose-500/90 px-4 py-3 text-base font-semibold text-white hover:bg-rose-400 disabled:opacity-50" ${
          team && team.round_active && !view.room.game_over && !(remain !== null && remain <= 0 && (team.current_word ?? null)) ? '' : 'disabled'
        } title="${team && remain !== null && remain <= 0 && (team.current_word ?? null) ? 'Сначала отметьте последнее слово (Угадал / Не знаю / Пропуск)' : ''}">
          Завершить раунд
        </button>
      </div>
      `
      : ''

  const history = team
    ? `
      <div class="mt-6 rounded-md bg-white/5 p-5 ring-1 ring-white/10">
        <div class="text-base text-slate-300">История слов (текущий раунд)</div>
        <div class="mt-3 max-h-[510px] overflow-y-auto pr-1">
          ${renderRoundHistory(team, true, !team.round_active)}
        </div>
      </div>
    `
    : ''

  return `
    <div class="flex items-start justify-between gap-3">
      <div>
        <div class="text-base font-semibold">Управление</div>
        ${remain === null ? '' : `<div class="mt-1 text-base text-slate-400">Таймер: <span id="roundTimerValue2">${remain}s</span></div>`}
      </div>
      <div class="flex items-center gap-2">
        ${dice}
        ${gear}
      </div>
    </div>
    ${settings}
    ${controls}
    ${history}
    <div id="rightError" class="mt-3 hidden rounded-md bg-rose-500/10 px-3 py-2 text-base text-rose-200 ring-1 ring-rose-500/20"></div>
  `
}

function renderRoundHistory(team: TeamPrivateView, onlyCurrent: boolean, editable = false) {
  const rounds = team.rounds || []
  if (!rounds.length) return `<div class="text-base text-slate-400">Пока пусто.</div>`

  const currentIdx = rounds.length - 1
  const list = onlyCurrent
    ? ([[currentIdx, currentIdx + 1, rounds[currentIdx]]] as [number, number, (typeof rounds)[0]][])
    : (rounds.map((r, i) => [i, i + 1, r] as [number, number, (typeof rounds)[0]]))

  return list
    .map(([roundIdx, n, events]) => {
      const items =
        events?.length
          ? events
              .map((e, wordIdx) => {
                const tag =
                  e.outcome === 'correct'
                    ? '<span class="rounded-full bg-emerald-500/20 px-2 py-0.5 text-base text-emerald-200 ring-1 ring-emerald-500/30">+1</span>'
                    : e.outcome === 'skip'
                      ? '<span class="rounded-full bg-rose-500/20 px-2 py-0.5 text-base text-rose-200 ring-1 ring-rose-500/30">-1</span>'
                      : '<span class="rounded-full bg-white/10 px-2 py-0.5 text-base text-slate-200 ring-1 ring-white/10">0</span>'
                const buttons =
                  editable
                    ? `<div class="flex flex-wrap gap-1" data-round-index="${roundIdx}" data-word-index="${wordIdx}">
                        <button type="button" class="setWordOutcomeBtn rounded-md bg-emerald-500/80 px-2 py-1 text-sm text-white hover:bg-emerald-400" data-outcome="correct">+1</button>
                        <button type="button" class="setWordOutcomeBtn rounded-md bg-white/10 px-2 py-1 text-sm text-slate-200 ring-1 ring-white/10 hover:bg-white/20" data-outcome="dont_know">0</button>
                        <button type="button" class="setWordOutcomeBtn rounded-md bg-rose-500/80 px-2 py-1 text-sm text-white hover:bg-rose-400" data-outcome="skip">−1</button>
                      </div>`
                    : tag
                return `<li class="flex items-center justify-between gap-3 rounded-md bg-white/5 px-3 py-2 ring-1 ring-white/10">
                  <span class="text-base font-medium text-slate-100">${escapeHtml(e.word)}</span>
                  ${buttons}
                </li>`
              })
              .join('')
          : `<div class="text-base text-slate-400">Пока слов нет.</div>`

      return `
        <div class="mt-3">
          ${onlyCurrent ? '' : `<div class="text-base text-slate-400">Раунд ${n}</div>`}
          ${editable ? '<div class="text-base text-slate-400 mb-2">Изменить очки за слово:</div>' : ''}
          <ul class="mt-2 grid gap-2">${items}</ul>
        </div>
      `
    })
    .join('')
}

function setError(id: string, message: string | null) {
  const el = document.getElementById(id)
  if (!el) return
  if (!message) {
    el.classList.add('hidden')
    el.textContent = ''
    return
  }
  el.classList.remove('hidden')
  el.textContent = message
}

function sendWs(obj: unknown) {
  if (!store.ws || store.ws.readyState !== WebSocket.OPEN) {
    setError('rightError', 'Нет подключения к серверу.')
    return
  }
  store.ws.send(JSON.stringify(obj))
}

async function connectWs(force: boolean) {
  if (!store.playerId) return
  if (!force && store.ws && (store.ws.readyState === WebSocket.OPEN || store.ws.readyState === WebSocket.CONNECTING)) return
  store.ws?.close()
  store.ws = null
  const wsUrl = `${API_BASE.replace('http', 'ws')}/ws`
  const ws = new WebSocket(wsUrl)
  store.ws = ws
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'hello', player_id: store.playerId }))
    store.connecting = false
    store.reconnectAttempt = 0
    if (store.reconnectTimerId != null) {
      window.clearTimeout(store.reconnectTimerId)
      store.reconnectTimerId = null
    }
    render()
  }
  ws.onmessage = (ev) => {
    try {
      const data = JSON.parse(ev.data) as WsState | WsError | WsPlayerLeft | WsLeft
      if (data.type === 'state') {
        const prevGameOver = store.view?.room?.game_over
        store.view = data.view
        if (store.settingsDraft && configKey(store.settingsDraft) === configKey(data.view.room.config)) store.settingsDirty = false
        if (!store.settingsDirty) store.settingsDraft = data.view.room.config
        if (!prevGameOver && data.view.room.game_over && data.view.room.winner_team_id != null) {
          const myTeamId = data.view.me.team_id
          if (myTeamId === data.view.room.winner_team_id) playWin()
          else if (myTeamId != null) playLose()
        }
        render()
      } else if (data.type === 'player_left') {
        showToastLeave(`${escapeHtml(data.player_name)} покинул комнату`)
      } else if ((data as WsLeft).type === 'left') {
        leaveRoomToLobby()
      } else {
        const err = data as WsError
        const msg =
          err.message === 'cannot_change_word_pack_after_game_started'
            ? 'Пак слов нельзя менять после начала первого раунда до конца игры'
            : err.message
        setError('rightError', msg)
      }
    } catch {
      // ignore
    }
  }
  ws.onclose = () => {
    store.connecting = false
    store.ws = null
    render()
    // Автопереподключение, если мы в комнате и не выходили сами
    if (store.playerId && store.playerRoomCode && store.reconnectTimerId == null) {
      const delay = Math.min(1000 * Math.pow(2, store.reconnectAttempt), 30000)
      store.reconnectAttempt = Math.min(store.reconnectAttempt + 1, 10)
      store.reconnectTimerId = window.setTimeout(() => {
        store.reconnectTimerId = null
        store.connecting = true
        render()
        void connectWs(true)
      }, delay)
    }
  }
  ws.onerror = () => {
    store.connecting = false
    setError('lobbyError', 'Не удалось подключиться к WebSocket. Проверьте, что бэкенд запущен на порту 8000.')
    render()
  }
}

function updateTargetLabel(mode: GameMode) {
  const el = document.getElementById('cfgTargetLabel')
  if (!el) return
  el.textContent = mode === 'to_words' ? 'Слов для победы' : 'Раундов до победы'
}

function updateDraftFromUi() {
  const modeEl = document.getElementById('cfgMode') as HTMLSelectElement | null
  const roundSecEl = document.getElementById('cfgRoundSec') as HTMLInputElement | null
  const targetEl = document.getElementById('cfgTarget') as HTMLInputElement | null
  const wordPackEl = document.getElementById('cfgWordPack') as HTMLSelectElement | null
  if (!modeEl || !roundSecEl || !targetEl || !store.view) return

  const base = store.settingsDraft ?? store.view.room.config
  const mode = modeEl.value as GameMode
  const round_seconds = Math.max(CONFIG_ROUND_SEC_MIN, Math.min(CONFIG_ROUND_SEC_MAX, Number(roundSecEl.value) || base.round_seconds))
  const targetRaw = Number(targetEl.value) || (mode === 'to_words' ? base.target_words : base.max_rounds)
  const targetWords = mode === 'to_words' ? Math.max(CONFIG_TARGET_WORDS_MIN, Math.min(CONFIG_TARGET_WORDS_MAX, targetRaw)) : base.target_words
  const maxRounds = mode === 'to_rounds' ? Math.max(CONFIG_MAX_ROUNDS_MIN, Math.min(CONFIG_MAX_ROUNDS_MAX, targetRaw)) : base.max_rounds
  const word_pack = (wordPackEl?.value as WordPack) ?? (base.word_pack ?? 'medium')

  store.settingsDraft = {
    mode,
    round_seconds,
    target_words: targetWords,
    max_rounds: maxRounds,
    word_pack,
  }
  store.settingsDirty = store.view ? configKey(store.settingsDraft) !== configKey(store.view.room.config) : false
  updateTargetLabel(mode)
  render()
}

function applyDraftSettings() {
  if (!store.view || !store.settingsDraft) return
  if (!canEditSettings(store.view)) return
  store.settingsDirty = configKey(store.settingsDraft) !== configKey(store.view.room.config)
  if (!store.settingsDirty) return
  sendWs({ type: 'update_settings', config: store.settingsDraft })
  showToast('Настройки применены')
}

async function loadRoomInfo() {
  const codeErr = validateRoomCode(store.roomCode)
  if (codeErr) {
    setError('lobbyError', codeErr)
    return
  }
  const code = store.roomCode.trim().toUpperCase()
  setError('lobbyError', null)
  try {
    store.lobbyRoomInfo = await fetchJson<RoomPublicView>(`${API_BASE}/api/rooms/${code}`, { method: 'GET' }, 4000)
  } catch {
    store.lobbyRoomInfo = null
  }
  render()
}

async function ensureJoinedSpectator(roomCode: string) {
  const codeErr = validateRoomCode(roomCode)
  if (codeErr) {
    setError('lobbyError', codeErr)
    return
  }
  const nameErr = validatePlayerName(store.playerName)
  if (nameErr) {
    setError('lobbyError', nameErr)
    return
  }
  const code = store.roomCode.trim().toUpperCase()

  // если playerId уже есть и он из этой комнаты — просто переподключаем WS
  if (store.playerId && store.playerRoomCode === code) {
    store.roomCode = code
    save()
    store.connecting = true
    render()
    await connectWs(true)
    return
  }

  const name = store.playerName.trim()
  try {
    setError('lobbyError', null)
    store.lobbyLoadingMessage = 'Входим в комнату…'
    render()
    const data = await fetchJson<{ room_id: string; player_id: string; team_id: string | null }>(
      `${API_BASE}/api/rooms/${code}/join`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ player_name: name, role: 'spectator' }) },
      6000,
    )
    store.roomCode = code
    store.playerId = data.player_id
    store.playerRoomCode = code
    store.teamCode = ''
    store.desiredRole = 'spectator'
    save()
    store.connecting = true
    render()
    await connectWs(true)
    store.lobbyLoadingMessage = null
    setError('lobbyError', null)
    render()
  } catch (e) {
    store.lobbyLoadingMessage = null
    setError('lobbyError', apiErrorMessage((e as Error).message))
    render()
  }
}

function leaveRoomToLobby() {
  // Возвращаемся на стартовый экран. Ник остаётся, чтобы было удобнее войти снова.
  history.pushState({}, '', '/')
  store.roomCode = ''
  store.teamCode = ''
  store.playerId = ''
  store.playerRoomCode = ''
  store.desiredRole = 'guesser'
  store.view = null
  store.connecting = false
  store.settingsDraft = null
  store.settingsDirty = false
  store.settingsOpen = false
  store.spectatorsOpen = false
  store.lobbyRoomInfo = null
  store.lobbyLoadingMessage = null
  store.ws?.close()
  store.ws = null
  if (store.reconnectTimerId != null) {
    window.clearTimeout(store.reconnectTimerId)
    store.reconnectTimerId = null
  }
  if (store.copiedRoomCodeTimerId != null) {
    window.clearTimeout(store.copiedRoomCodeTimerId)
    store.copiedRoomCodeTimerId = null
  }
  store.copiedRoomCode = null
  store.reconnectAttempt = 0
  save()
  render()
}

async function createRoom() {
  const nameErr = validatePlayerName(store.playerName)
  if (nameErr) {
    setError('lobbyError', nameErr)
    return
  }
  try {
    setError('lobbyError', null)
    store.lobbyLoadingMessage = 'Создаём комнату…'
    render()
    const data = await fetchJson<{ room_id: string; room_code: string }>(
      `${API_BASE}/api/rooms`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Комната' }) },
      6000,
    )
    store.roomCode = data.room_code
    save()
    history.pushState({}, '', `/${store.roomCode}`)
    await loadRoomInfo()
    store.lobbyLoadingMessage = null
    render()
    await ensureJoinedSpectator(store.roomCode)
  } catch (e) {
    store.lobbyLoadingMessage = null
    setError('lobbyError', apiErrorMessage((e as Error).message))
    render()
  }
}

async function joinTeamByCode(team_code: string, role: PlayerRole = 'guesser') {
  const roomCode = store.roomCode.trim().toUpperCase()
  if (!roomCode) return
  if (!store.playerId) return
  try {
    setError('rightError', null)
    await fetchJson<{ player_id: string; team_id: string; role: PlayerRole }>(
      `${API_BASE}/api/rooms/${roomCode}/players/${store.playerId}/team`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ team_code, role }) },
      6000,
    )
    store.teamCode = team_code.toUpperCase()
    store.desiredRole = role
    save()
  } catch (e) {
    setError('rightError', apiErrorMessage((e as Error).message))
  }
}

async function createTeamAndJoin() {
  const roomCode = store.roomCode.trim().toUpperCase()
  if (!roomCode) return
  if (!store.playerId) return
  const n = (store.view?.room.teams?.length ?? 0) + 1
  try {
    setError('rightError', null)
    const data = await fetchJson<{ team_id: string; team_code: string }>(
      `${API_BASE}/api/rooms/${roomCode}/teams`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: `Команда ${n}` }) },
      6000,
    )
    await joinTeamByCode(data.team_code, 'guesser')
  } catch (e) {
    setError('rightError', apiErrorMessage((e as Error).message))
  }
}

async function randomizeTeamsAndRoles() {
  const roomCode = store.roomCode.trim().toUpperCase()
  if (!roomCode) return
  try {
    setError('rightError', null)
    await fetchJson<{ ok: boolean }>(`${API_BASE}/api/rooms/${roomCode}/randomize`, { method: 'POST' }, 6000)
  } catch (e) {
    setError('rightError', apiErrorMessage((e as Error).message))
  }
}

async function restartGame() {
  const roomCode = store.roomCode.trim().toUpperCase()
  if (!roomCode) return
  if (!store.playerId) return
  try {
    setError('rightError', null)
    await fetchJson<{ ok: boolean }>(`${API_BASE}/api/rooms/${roomCode}/players/${store.playerId}/restart`, { method: 'POST' }, 6000)
    showToast('Игра перезапущена')
  } catch (e) {
    setError('rightError', apiErrorMessage((e as Error).message))
    showToast('Не удалось перезапустить')
  }
}

async function changeMyRole(role: PlayerRole) {
  const roomCode = store.roomCode.trim().toUpperCase()
  if (!roomCode) return
  if (!store.playerId) return
  try {
    setError('teamError', null)
    await fetchJson<{ player_id: string; role: PlayerRole; team_id: string | null }>(
      `${API_BASE}/api/rooms/${roomCode}/players/${store.playerId}/role`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role }) },
      6000,
    )
    store.desiredRole = role
    save()
  } catch (e) {
    setError('teamError', apiErrorMessage((e as Error).message))
  }
}

function wireHandlers() {
  const playerName = document.getElementById('playerName') as HTMLInputElement | null
  const roomCode = document.getElementById('roomCode') as HTMLInputElement | null

  playerName?.addEventListener('input', () => {
    store.playerName = playerName.value
    save()
  })
  roomCode?.addEventListener('input', () => {
    store.roomCode = roomCode.value.toUpperCase()
    save()
    const enterBtn = document.getElementById('enterRoom') as HTMLButtonElement | null
    if (enterBtn) enterBtn.disabled = !store.roomCode.trim()
    const row = document.getElementById('lobbyRoomCodeRow')
    if (row) {
      const codeUpper = store.roomCode.trim().toUpperCase()
      const isCopied = store.copiedRoomCode === codeUpper
      row.innerHTML = store.roomCode
        ? `<div class="flex flex-wrap items-center gap-2 text-base text-slate-400">
            <span>Комната:</span>
            <button type="button" class="copyRoomCode inline-flex items-center gap-1 font-mono tracking-widest underline decoration-dotted underline-offset-4 hover:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/60 ${isCopied ? 'text-emerald-400' : 'text-slate-200'}" title="Нажмите, чтобы скопировать код комнаты" data-roomcode="${escapeHtml(store.roomCode)}">${isCopied ? 'Скопировано ✓' : `/${escapeHtml(store.roomCode)}`}</button>
            <button id="loadRoom" type="button" class="rounded-md bg-white/10 px-2 py-1 text-sm text-slate-300 hover:bg-white/15">Обновить</button>
          </div>`
        : `<div class="text-base text-slate-400"></div>`
      document.getElementById('loadRoom')?.addEventListener('click', () => void loadRoomInfo())
    }
  })

  ;(document.getElementById('createRoom') as HTMLButtonElement | null)?.addEventListener('click', () => void createRoom())
  ;(document.getElementById('loadRoom') as HTMLButtonElement | null)?.addEventListener('click', () => void loadRoomInfo())
  ;(document.getElementById('enterRoom') as HTMLButtonElement | null)?.addEventListener('click', () => void ensureJoinedSpectator(store.roomCode))
  ;(document.getElementById('leaveRoom') as HTMLButtonElement | null)?.addEventListener('click', () => {
    if (store.ws?.readyState === WebSocket.OPEN) {
      sendWs({ type: 'leave_room' })
    } else {
      leaveRoomToLobby()
    }
  })
  ;(document.getElementById('reconnectBtn') as HTMLButtonElement | null)?.addEventListener('click', () => {
    if (store.playerId) {
      store.reconnectAttempt = 0
      store.connecting = true
      render()
      void connectWs(true)
    }
  })

  const uploadWordsBtn = document.getElementById('uploadWordsBtn') as HTMLButtonElement | null
  const wordsCsvInput = document.getElementById('wordsCsvInput') as HTMLInputElement | null
  uploadWordsBtn?.addEventListener('click', () => wordsCsvInput?.click())
  wordsCsvInput?.addEventListener('change', async () => {
    const file = wordsCsvInput.files?.[0]
    wordsCsvInput.value = ''
    if (!file || !store.view?.room?.code) return
    const roomCode = store.roomCode.trim().toUpperCase()
    if (!roomCode) return
    const fd = new FormData()
    fd.append('file', file)
    try {
      const res = await fetch(`${API_BASE}/api/rooms/${roomCode}/words`, { method: 'POST', body: fd })
      if (!res.ok) throw new Error(await res.text())
      const data = (await res.json()) as { ok: boolean; name: string }
      showToast(`Пак «${data.name}» загружен`)
      if (store.view) {
        store.view = {
          ...store.view,
          room: { ...store.view.room, custom_words_name: data.name },
        }
      }
      render()
    } catch (e) {
      const errMsg = (e as Error).message
      showToast(
        errMsg === 'cannot_change_word_pack_after_game_started'
          ? 'Пак слов нельзя менять после начала первого раунда до конца игры'
          : apiErrorMessage(errMsg),
      )
    }
  })

  // copyRoomCode обрабатывается через делегирование в init (чтобы работало и после частичного обновления поля кода комнаты)

  ;(document.getElementById('toggleSettings') as HTMLButtonElement | null)?.addEventListener('click', () => {
    store.settingsOpen = !store.settingsOpen
    render()
  })

  ;(document.getElementById('addTeamBtn') as HTMLButtonElement | null)?.addEventListener('click', () => void createTeamAndJoin())
  ;(document.getElementById('randomizeBtn') as HTMLButtonElement | null)?.addEventListener('click', () => void randomizeTeamsAndRoles())
  ;(document.getElementById('toggleRoleBtn') as HTMLButtonElement | null)?.addEventListener('click', () => {
    const next: PlayerRole = store.view?.me?.role === 'cluegiver' ? 'guesser' : 'cluegiver'
    void changeMyRole(next)
  })

  ;(document.getElementById('restartGame') as HTMLButtonElement | null)?.addEventListener('click', () => void restartGame())
  ;(document.getElementById('restartGameInSettings') as HTMLButtonElement | null)?.addEventListener('click', () => void restartGame())

  // joinTeamBtn и becomeSpectatorBtn обрабатываются через делегирование в init

  ;(document.getElementById('startRound') as HTMLButtonElement | null)?.addEventListener('click', () => sendWs({ type: 'start_round' }))
  ;(document.getElementById('endRound') as HTMLButtonElement | null)?.addEventListener('click', () => sendWs({ type: 'end_round' }))

  ;(document.getElementById('markCorrect') as HTMLButtonElement | null)?.addEventListener('click', () => {
    playCorrect()
    sendWs({ type: 'mark', outcome: 'correct' })
  })
  ;(document.getElementById('markDontKnow') as HTMLButtonElement | null)?.addEventListener('click', () => {
    playDontKnow()
    sendWs({ type: 'mark', outcome: 'dont_know' })
  })
  ;(document.getElementById('markSkip') as HTMLButtonElement | null)?.addEventListener('click', () => {
    playSkip()
    sendWs({ type: 'mark', outcome: 'skip' })
  })

  appEl.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest('.setWordOutcomeBtn') as HTMLButtonElement | null
    if (!btn) return
    const wrap = btn.closest('[data-round-index][data-word-index]') as HTMLElement | null
    if (!wrap) return
    const roundIndex = parseInt(wrap.dataset.roundIndex ?? '', 10)
    const wordIndex = parseInt(wrap.dataset.wordIndex ?? '', 10)
    const outcome = (btn.dataset.outcome ?? 'dont_know') as 'correct' | 'dont_know' | 'skip'
    if (Number.isNaN(roundIndex) || Number.isNaN(wordIndex)) return
    setError('rightError', null)
    sendWs({ type: 'set_word_outcome', round_index: roundIndex, word_index: wordIndex, outcome })
  })

  const modeEl = document.getElementById('cfgMode') as HTMLSelectElement | null
  const roundSecEl = document.getElementById('cfgRoundSec') as HTMLInputElement | null
  const targetEl = document.getElementById('cfgTarget') as HTMLInputElement | null
  const wordPackEl = document.getElementById('cfgWordPack') as HTMLSelectElement | null

  function syncDraftAndApply() {
    updateDraftFromUi()
    applyDraftSettings()
  }

  modeEl?.addEventListener('change', syncDraftAndApply)
  wordPackEl?.addEventListener('change', syncDraftAndApply)
  roundSecEl?.addEventListener('input', updateDraftFromUi)
  targetEl?.addEventListener('input', updateDraftFromUi)
  roundSecEl?.addEventListener('blur', syncDraftAndApply)
  targetEl?.addEventListener('blur', syncDraftAndApply)
}

// Делегирование: копирование кода комнаты (работает и для кнопки, вставленной при вводе кода без полного render)
const COPIED_ROOM_CODE_DURATION_MS = 2000
appEl.addEventListener('click', async (e) => {
  const btn = (e.target as HTMLElement).closest('.copyRoomCode') as HTMLButtonElement | null
  if (!btn) return
  const raw = (btn.dataset.roomcode ?? '').trim()
  const code = raw.replace(/^\//, '')
  if (!code) return
  const ok = await copyToClipboard(code)
  showToast(ok ? 'Код комнаты скопирован' : 'Не удалось скопировать')
  if (ok) {
    if (store.copiedRoomCodeTimerId != null) window.clearTimeout(store.copiedRoomCodeTimerId)
    store.copiedRoomCode = code
    store.copiedRoomCodeTimerId = window.setTimeout(() => {
      store.copiedRoomCodeTimerId = null
      store.copiedRoomCode = null
      render()
    }, COPIED_ROOM_CODE_DURATION_MS)
    render()
  }
})

// Делегирование: клик по панели команды (под «Комната /ID») — вступить в команду
function handleJoinTeamClick(el: HTMLElement | null) {
  if (!el) return
  if ('disabled' in el && (el as HTMLButtonElement).disabled) return
  const code = el.dataset.teamcode
  if (!code) return
  // Уже в этой команде — ничего не делаем (иначе повторный вход сбрасывает роль на угадывающего)
  if (store.teamCode && store.teamCode.toUpperCase() === code.toUpperCase()) return
  const view = store.view
  const team = view?.room?.teams?.find((t) => t.code.toUpperCase() === code.toUpperCase())
  const role: PlayerRole = team && team.players_count === 0 ? 'cluegiver' : 'guesser'
  void joinTeamByCode(code, role)
}
appEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.joinTeamBtn') as HTMLElement | null
  handleJoinTeamClick(btn)
})
appEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return
  const btn = (e.target as HTMLElement).closest('.joinTeamBtn') as HTMLElement | null
  if (!btn) return
  e.preventDefault()
  handleJoinTeamClick(btn)
})

// Делегирование: клик по панели «Игроки без команды» — выйти в наблюдатели
appEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.becomeSpectatorBtn') as HTMLButtonElement | null
  if (!btn) return
  void changeMyRole('spectator')
})

// Делегирование: мобильные табы «Команда» / «Управление»
appEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.alias-mobile-tab') as HTMLButtonElement | null
  if (!btn) return
  const tab = btn.dataset.tab as 'team' | 'controls' | undefined
  if (tab === 'team' || tab === 'controls') {
    store.mobileTab = tab
    render()
  }
})

// Мобильный вид: lg = 1024px
const LG_BREAKPOINT = 1024
function updateIsMobile() {
  const next = window.innerWidth < LG_BREAKPOINT
  if (store.isMobile !== next) {
    store.isMobile = next
    render()
  }
}
store.isMobile = window.innerWidth < LG_BREAKPOINT
window.addEventListener('resize', updateIsMobile)

// init from URL
const urlRoom = parseRoomCodeFromUrl()
if (urlRoom) {
  store.roomCode = urlRoom
  // если перешли в другую комнату — сбрасываем playerId, чтобы не ловить unknown_player_id
  if (store.playerId && store.playerRoomCode && store.playerRoomCode !== urlRoom) {
    store.playerId = ''
    store.teamCode = ''
    store.playerRoomCode = ''
    store.view = null
    store.ws?.close()
    store.ws = null
  }
  save()
  void loadRoomInfo()
} else {
  // На главной странице считаем, что мы НЕ в комнате (даже если roomCode остался в localStorage)
  store.roomCode = ''
  store.teamCode = ''
  store.lobbyRoomInfo = null
}

render()

if (store.playerId) {
  void connectWs(false)
}

// Горячие клавиши для загадывающего: 1 — Угадал, 2 — Не знаю, 3 — Пропуск
document.addEventListener('keydown', (e) => {
  const view = store.view
  const team = view?.my_team
  if (!view || !team || view.me.role !== 'cluegiver' || team.cluegiver_id !== view.me.id || !team.round_active) return
  const active = document.activeElement as HTMLElement | null
  if (active?.tagName === 'INPUT' || active?.tagName === 'TEXTAREA' || active?.tagName === 'SELECT') return
  if (e.key === '1') {
    e.preventDefault()
    if (store.ws?.readyState === WebSocket.OPEN) {
      playCorrect()
      store.ws.send(JSON.stringify({ type: 'mark', outcome: 'correct' }))
    }
  } else if (e.key === '2') {
    e.preventDefault()
    if (store.ws?.readyState === WebSocket.OPEN) {
      playDontKnow()
      store.ws.send(JSON.stringify({ type: 'mark', outcome: 'dont_know' }))
    }
  } else if (e.key === '3') {
    e.preventDefault()
    if (store.ws?.readyState === WebSocket.OPEN) {
      playSkip()
      store.ws.send(JSON.stringify({ type: 'mark', outcome: 'skip' }))
    }
  }
})

window.setInterval(() => {
  store.nowMs = Date.now()
  updateTimerTexts()
}, 100)

