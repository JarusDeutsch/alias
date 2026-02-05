import { getLocale, type Locale, LOCALES, pluralPoints, pluralWords, setLocale, t } from './i18n'
import { log, exposeToWindow } from './logger'
import QRCode from 'qrcode'
import { drawShareCard, shareCardBlobAsFile, type ShareCardParams } from './share-card'
import { playCorrect, playDontKnow, playLose, playSkip, playTick, playWin } from './sounds'

exposeToWindow()

type PlayerRole = 'cluegiver' | 'guesser' | 'spectator'
type GameMode = 'to_words' | 'to_rounds'
type GuessOutcome = 'correct' | 'dont_know' | 'skip'

type WordPack = 'simple' | 'medium' | 'hard'
type WordPackLang = 'ru' | 'uk' | 'en'

type GameConfig = {
  mode: GameMode
  round_seconds: number
  target_words: number
  max_rounds: number
  word_pack?: WordPack
  word_pack_lang?: WordPackLang
  /** true = только загадывающий; false = любой игрок в команде может менять настройки */
  only_cluegiver_can_edit_settings?: boolean
}

/** Черновик настроек; флаги _*Empty позволяют показывать пустое поле вместо подстановки минимума */
type SettingsDraft = GameConfig & { _roundSecEmpty?: boolean; _targetEmpty?: boolean }

function toEffectiveConfig(draft: SettingsDraft, base: GameConfig): GameConfig {
  const mode = draft.mode
  return {
    ...draft,
    round_seconds: draft._roundSecEmpty ? base.round_seconds : draft.round_seconds,
    target_words: mode === 'to_words' && draft._targetEmpty ? base.target_words : draft.target_words,
    max_rounds: mode === 'to_rounds' && draft._targetEmpty ? base.max_rounds : draft.max_rounds,
  }
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

type ActiveTeamView = { id: string; name: string; rounds: WordEvent[][]; round_ends_at?: string | null }

type WsView = {
  room: RoomPublicView
  me: { id: string; name: string; role: PlayerRole; team_id: string | null }
  my_team: TeamPrivateView | null
  spectator_teams?: TeamPrivateView[] | null
  active_team?: ActiveTeamView | null
  /** id команды, которой разрешено начать следующий раунд (с сервера) */
  can_start_round_team_id?: string | null
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

declare const __BUILD_TIMESTAMP__: string | undefined
function buildVersion(): string {
  const ts = typeof __BUILD_TIMESTAMP__ !== 'undefined' ? __BUILD_TIMESTAMP__ : null
  if (!ts) return 'dev'
  const m = ts.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)
  return m ? `v${m[1]}.${m[2]}.${m[3]}.${m[4]}.${m[5]}` : ts.slice(0, 16)
}
const BUILD_VERSION = buildVersion()
if (appEl) appEl.dataset.build = BUILD_VERSION

setLocale(getLocale())
applyTheme()

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
  'Играй в слова',
  'Угадайка',
  'Alias онлайн',
]
const tagline = TAGLINES[Math.floor(Math.random() * TAGLINES.length)]

const WORD_OF_DAY_LIST = [
  'кофе', 'книга', 'солнце', 'море', 'дождь', 'окно', 'друг', 'счастье', 'музыка', 'путешествие',
  'пицца', 'телефон', 'компьютер', 'кошка', 'собака', 'цветок', 'горы', 'река', 'звезда', 'луна',
]
function wordOfDay(): string {
  const day = Math.floor(Date.now() / 86400000)
  return WORD_OF_DAY_LIST[day % WORD_OF_DAY_LIST.length]
}

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
  pendingWordOutcome: false,
  settingsDraft: null as SettingsDraft | null,
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
  shareModalOpen: false,
  shareCardPreviewUrl: null as string | null,
  shareCardBlob: null as Blob | null,
  lastTickSecond: null as number | null,
  theme: (localStorage.getItem('alias_theme') as 'dark' | 'light') ?? 'dark',
  firstVisitDone: localStorage.getItem('alias_first_visit_done') === '1',
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

function applyTheme() {
  const isLight = store.theme === 'light'
  document.documentElement.classList.toggle('alias-theme-light', isLight)
}

function configKey(c: GameConfig): string {
  return `${c.mode}|${c.round_seconds}|${c.target_words}|${c.max_rounds}|${c.word_pack ?? 'medium'}|${c.word_pack_lang ?? 'ru'}|${c.only_cluegiver_can_edit_settings !== false}`
}

function parseRoomCodeFromUrl(): string | null {
  const p = window.location.pathname.replace(/^\/+|\/+$/g, '')
  if (!p) return null
  if (!/^[A-Za-z0-9]{4,10}$/.test(p)) return null
  return p.toUpperCase()
}

function validatePlayerName(name: string): string | null {
  const s = name.trim()
  if (s.length < PLAYER_NAME_MIN_LEN) return t('err_enter_name')
  if (s.length > PLAYER_NAME_MAX_LEN) return t('err_name_max', { max: PLAYER_NAME_MAX_LEN })
  return null
}

function validateRoomCode(code: string): string | null {
  const s = code.trim().toUpperCase()
  if (s.length < ROOM_CODE_MIN_LEN) return t('err_enter_room_code')
  if (s.length > ROOM_CODE_MAX_LEN) return t('err_room_code_length', { min: ROOM_CODE_MIN_LEN, max: ROOM_CODE_MAX_LEN })
  if (!/^[A-Za-z0-9]+$/.test(s)) return t('err_room_code_alnum')
  return null
}

function apiErrorMessage(detail: string): string {
  return t(detail)
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
  if (!view.me.team_id || view.room.game_over) return false
  const gameStarted = view.room.teams?.some((t) => t.round_number > 0) ?? false
  if (gameStarted) return false
  const onlyCluegiver = view.room.config.only_cluegiver_can_edit_settings !== false
  return !onlyCluegiver || view.me.role === 'cluegiver'
}

function remainingSecondsFromEndAt(roundEndsAt: string | null | undefined): number | null {
  if (!roundEndsAt) return null
  const end = Date.parse(roundEndsAt)
  if (Number.isNaN(end)) return null
  return Math.max(0, Math.ceil((end - store.nowMs) / 1000))
}

let cachedRemain: { sec: number; ms: number; roundEndsAt: string } | null = null

/** Оставшееся время текущего раунда для отображения (своя команда или активная). Кэш убирает мигание при обновлении state. */
function displayRemainingSeconds(view: WsView | null): number | null {
  if (!view?.room?.config) return null
  const inRound = view.my_team?.round_active || !!view.active_team
  const team = view.my_team
  let sec: number | null = null
  let endAt: string | null = null
  if (team?.round_active && team.round_ends_at) {
    endAt = team.round_ends_at
    sec = remainingSecondsFromEndAt(team.round_ends_at)
  }
  if (sec === null && view.active_team?.round_ends_at) {
    endAt = view.active_team.round_ends_at
    sec = remainingSecondsFromEndAt(view.active_team.round_ends_at)
  }
  if (sec !== null && endAt) {
    const end = Date.parse(endAt)
    cachedRemain = { sec, ms: Math.max(0, end - store.nowMs), roundEndsAt: endAt }
    return sec
  }
  if (inRound && cachedRemain) return cachedRemain.sec
  cachedRemain = null
  return null
}

function displayRemainingMs(view: WsView | null): number | null {
  if (!view?.room?.config) return null
  const inRound = view.my_team?.round_active || !!view.active_team
  const team = view.my_team
  let ms: number | null = null
  let endAt: string | null = null
  if (team?.round_active && team.round_ends_at) {
    endAt = team.round_ends_at
    const end = Date.parse(team.round_ends_at)
    ms = Number.isNaN(end) ? null : Math.max(0, end - store.nowMs)
  }
  if (ms === null && view.active_team?.round_ends_at) {
    endAt = view.active_team.round_ends_at
    const end = Date.parse(view.active_team.round_ends_at)
    ms = Number.isNaN(end) ? null : Math.max(0, end - store.nowMs)
  }
  if (ms !== null && endAt) {
    cachedRemain = cachedRemain ? { ...cachedRemain, ms, roundEndsAt: endAt } : { sec: Math.ceil(ms / 1000), ms, roundEndsAt: endAt }
    return ms
  }
  if (inRound && cachedRemain) return cachedRemain.ms
  cachedRemain = null
  return null
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
  const sec = Math.max(0, Math.floor(totalSeconds))
  const m = Math.floor(sec / 60)
  const secStr = String(sec % 60).padStart(2, '0')
  return `${m}:${secStr}`
}

function updateTimerTexts() {
  const remain = displayRemainingSeconds(store.view ?? null)
  const text = remain === null ? '' : `${remain}s`
  const a = document.getElementById('roundTimerValue')
  if (a) a.textContent = text
  const b = document.getElementById('roundTimerValue2')
  if (b) b.textContent = text

  // Global big timer (top of game screen)
  const wrap = document.getElementById('globalTimerWrap')
  const digits = document.getElementById('globalTimerDigits')
  const bar = document.getElementById('globalTimerBarInner') as HTMLDivElement | null
  const ms = displayRemainingMs(store.view ?? null)
  if (!wrap || !digits || !bar || !store.view) return

  if (ms === null) {
    wrap.classList.add('hidden')
    wrap.classList.remove('alias-timer-red')
    bar.style.width = '0%'
    bar.style.backgroundImage = ''
    digits.textContent = ''
    const pageBg = document.querySelector('.alias-page-bg') as HTMLElement | null
    if (pageBg) pageBg.classList.remove('alias-page-bg-red-tint')
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

  // Звук «последние 5 секунд» — один тик на каждую секунду 5,4,3,2,1
  const sec = ms === null ? null : Math.ceil(ms / 1000)
  if (sec !== null && sec <= 5 && sec >= 1 && sec !== store.lastTickSecond) {
    store.lastTickSecond = sec
    playTick()
  }
  if (sec === null || sec > 5) store.lastTickSecond = null

  // Красный отлив фона при остатке ≤10% — обновляем в тике, чтобы не ждать следующего render()
  const pageBg = document.querySelector('.alias-page-bg') as HTMLElement | null
  if (pageBg) {
    const isLowTime = totalMs > 0 && ms <= totalMs * 0.1 && ms > 0
    pageBg.classList.toggle('alias-page-bg-red-tint', isLowTime)
  }
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
            <div class="text-base text-slate-400">${t('spectators_title')}</div>
            <div class="mt-2 flex flex-wrap gap-2">
              ${spectators.length ? spectators.map((n) => `<span class="rounded-full bg-white/10 px-2 py-1 text-base text-slate-200 ring-1 ring-white/10">${escapeHtml(n)}</span>`).join('') : `<span class="text-base text-slate-500">${t('spectators_empty')}</span>`}
            </div>`
          if (gameStartedForHeader) {
            return `<div class="rounded-md bg-white/5 p-3 ring-1 ring-white/10 min-w-[160px]">${content}</div>`
          }
          return `<button type="button" class="becomeSpectatorBtn rounded-md bg-white/5 p-3 ring-1 ring-white/10 min-w-[160px] text-left hover:bg-white/10 hover:ring-white/20 focus:outline-none focus:ring-2 focus:ring-indigo-500/60 cursor-pointer transition-colors" title="${t('spectators_click_leave')}">${content}</button>`
        })()
      : ''

  const reconnectBtn =
    view && store.playerId && !connected && !connecting
      ? `<button id="reconnectBtn" type="button" class="ml-2 rounded-md bg-sky-500/80 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-400">${t('reconnect')}</button>`
      : ''
  const langSwitcher = `
    <div class="alias-lang-switcher inline-flex rounded-lg bg-white/5 p-0.5 ring-1 ring-white/10" role="group" aria-label="Language">
      ${LOCALES.map(
        (loc) =>
          `<button type="button" class="alias-lang-btn min-w-[2.25rem] rounded-md px-2 py-1.5 text-sm font-medium transition-colors ${getLocale() === loc.code ? 'bg-indigo-500/80 text-white' : 'text-slate-400 hover:bg-white/10 hover:text-slate-200'}" data-locale="${loc.code}" title="${escapeHtml(loc.native)}">${loc.label}</button>`,
      ).join('')}
    </div>`
  const themeToggle = `
    <button type="button" id="themeToggle" class="alias-theme-toggle inline-flex h-9 w-9 items-center justify-center rounded-lg bg-white/5 ring-1 ring-white/10 hover:bg-white/10 text-slate-300 hover:text-slate-100" title="${store.theme === 'dark' ? 'Светлая тема' : 'Тёмная тема'}" aria-label="Тема">
      ${store.theme === 'dark' ? '<svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"/></svg>' : '<svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"/></svg>'}
    </button>`
  const header = `
    <div class="flex items-center justify-between gap-3">
      <div>
        <div class="flex flex-wrap items-center gap-2">
          <div class="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-0.5 text-sm text-slate-200 ring-1 ring-white/10">
            <span class="h-2 w-2 rounded-full ${connected ? 'bg-emerald-400' : connecting ? 'bg-sky-400' : 'bg-amber-400'}"></span>
            <span>${connected ? t('status_connected') : connecting ? t('status_connecting') : t('status_disconnected')}</span>
            ${reconnectBtn}
          </div>
          ${langSwitcher}
          ${themeToggle}
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
      <button type="button" id="uploadWordsBtn" title="${!canChangeWordPackBtn ? t('word_pack_locked') : view.room.custom_words_name ? t('word_pack_uploaded') : t('word_pack_upload_hint')}"
        class="rounded-md bg-white/10 px-3 py-2 text-sm font-medium text-slate-200 ring-1 ring-white/10 hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-indigo-500/60 disabled:opacity-50 disabled:cursor-not-allowed"
        ${canChangeWordPackBtn ? '' : 'disabled'}>
        ${escapeHtml(view.room.custom_words_name ?? t('word_pack_upload_btn'))}
      </button>
    </div>`
      : ''

  const shareModalHtml = store.shareModalOpen ? renderShareModal() : ''
  const mainContent = `
    <div class="alias-page-bg min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-indigo-950 text-slate-100">
      <div class="relative z-10 mx-auto max-w-[1520px] px-4 py-8">
        <div id="aliasHeaderWrap">${header}</div>
        <div id="aliasBodyWrap" class="alias-divider mt-8 pt-8">${body}</div>
      </div>
    </div>
    ${wordsUploadEl}
    ${shareModalHtml}
  `

  let mainEl = document.getElementById('aliasMain')
  if (!mainEl) {
    appEl.innerHTML = `
    <div id="aliasMain"></div>
    <div id="aliasToast" class="pointer-events-none fixed bottom-4 left-1/2 z-50 hidden -translate-x-1/2 rounded-md bg-slate-950/80 px-3 py-1.5 text-sm text-white ring-1 ring-white/10 backdrop-blur">toast</div>
    <div id="aliasToastLeave" class="pointer-events-none fixed bottom-4 left-1/2 z-50 hidden -translate-x-1/2 rounded-md bg-rose-600/95 px-3 py-1.5 text-sm text-white ring-1 ring-rose-400/30 backdrop-blur">leave</div>
    <div class="alias-build-version fixed bottom-2 left-2 z-40 select-none font-mono text-xs text-slate-400/50" aria-hidden="true">${BUILD_VERSION}</div>
    `
    mainEl = document.getElementById('aliasMain')!
  }

  mainEl.innerHTML = mainContent
  wireHandlers()
}

function renderShareModal(): string {
  const previewUrl = store.shareCardPreviewUrl
  const hasBlob = !!store.shareCardBlob
  const previewContent = previewUrl
    ? `<img src="${previewUrl}" alt="" class="max-h-[280px] w-auto rounded-lg ring-1 ring-white/10 object-contain" />`
    : `<div class="flex items-center justify-center py-16"><span class="alias-spinner"></span></div>`
  return `
    <div id="shareModalBackdrop" class="alias-share-modal-backdrop fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" role="dialog" aria-modal="true" aria-label="${escapeHtml(t('share_card_preview'))}">
      <div class="alias-share-modal-content rounded-xl bg-slate-800/95 p-6 ring-1 ring-white/10 shadow-xl max-w-lg w-full" onclick="event.stopPropagation()">
        <div class="text-base font-semibold text-slate-100">${t('share_card_preview')}</div>
        <div class="mt-4 flex justify-center rounded-lg bg-slate-900/50 min-h-[200px]">${previewContent}</div>
        <div class="mt-4 flex flex-wrap gap-2 justify-end">
          <button id="shareModalClose" type="button" class="rounded-md bg-white/10 px-4 py-2 text-sm font-medium text-slate-200 ring-1 ring-white/10 hover:bg-white/15">${t('share_modal_close')}</button>
          <button id="shareModalDownload" type="button" class="rounded-md bg-emerald-500/90 px-4 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-50" ${hasBlob ? '' : 'disabled'}>${t('share_download')}</button>
          <button id="shareModalShare" type="button" class="rounded-md bg-indigo-500 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-400 disabled:opacity-50" ${hasBlob ? '' : 'disabled'}>${t('share_share')}</button>
        </div>
      </div>
    </div>
  `
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

  const firstVisitBanner = !store.firstVisitDone
    ? `
    <div class="mb-4 rounded-md bg-indigo-500/15 px-4 py-3 ring-1 ring-indigo-500/30">
      <p class="text-sm text-indigo-100/95">Введите имя и код комнаты. Загадывающий может нажимать клавиши <kbd class="rounded bg-white/20 px-1">1</kbd>, <kbd class="rounded bg-white/20 px-1">2</kbd>, <kbd class="rounded bg-white/20 px-1">3</kbd> для быстрой отметки слова.</p>
      <button id="dismissFirstVisit" type="button" class="mt-2 text-sm font-medium text-indigo-200 underline decoration-dotted hover:text-indigo-100">Понятно</button>
    </div>`
    : ''

  return `
    <h2 class="text-lg font-semibold">${t('lobby_title')}</h2>
    <p class="mt-1 text-base text-slate-300">${t('lobby_subtitle')}</p>
    ${firstVisitBanner}

    <div class="mt-5 grid gap-3">
      <label class="grid gap-1">
        <span class="text-base text-slate-300">${t('your_name')}</span>
        <input id="playerName" value="${escapeHtml(store.playerName)}" placeholder="${t('name_placeholder')}" maxlength="${PLAYER_NAME_MAX_LEN}"
          class="rounded-md bg-white/5 px-2.5 py-1.5 text-sm ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-500/60" />
      </label>

      <label class="grid gap-1">
        <span class="text-base text-slate-300">${t('room_code_label')}</span>
        <input id="roomCode" value="${escapeHtml(store.roomCode)}" placeholder="${t('room_code_placeholder')}" maxlength="${ROOM_CODE_MAX_LEN}"
          class="rounded-md bg-white/5 px-2.5 py-1.5 text-sm uppercase tracking-widest ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-500/60" />
      </label>

      ${
        fromUrl && codeDisplay
          ? `
      <div class="mt-1 rounded-md bg-emerald-500/15 p-4 ring-2 ring-emerald-500/40">
        <p class="text-base font-medium text-emerald-100">${t('invited_to_room')}</p>
        <button id="enterRoom" type="button" class="mt-3 w-full rounded-md bg-emerald-500 px-5 py-3.5 text-lg font-semibold text-emerald-950 hover:bg-emerald-400 focus:outline-none focus:ring-2 focus:ring-emerald-400 focus:ring-offset-2 focus:ring-offset-slate-900">
          ${t('enter_room')} /${codeDisplay}
        </button>
      </div>
      <div class="mt-1">
        <button id="createRoom" class="min-w-[10.5rem] rounded-md bg-white/10 px-4 py-2 text-sm font-semibold text-slate-200 ring-1 ring-white/10 hover:bg-white/15">
          ${t('create_own_room')}
        </button>
      </div>`
          : `
      <div class="mt-1 grid gap-2 sm:grid-cols-2">
        <button id="createRoom" class="min-w-[10.5rem] rounded-md bg-indigo-500 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-400">
          ${t('create_room')}
        </button>
        <button id="enterRoom" class="min-w-[10.5rem] rounded-md bg-emerald-500 px-4 py-2 text-sm font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-50" ${store.roomCode.trim() ? '' : 'disabled'}>
          ${t('enter_by_code')}
        </button>
      </div>`
      }

      <div id="lobbyRoomCodeRow">${
        store.roomCode
          ? `<div class="flex flex-wrap items-center gap-2 text-base text-slate-400">
              <span>${t('room_label')}:</span>
              <button
                type="button"
                class="copyRoomCode inline-flex items-center gap-1 font-mono tracking-widest underline decoration-dotted underline-offset-4 hover:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/60 ${store.copiedRoomCode === store.roomCode.trim().toUpperCase() ? 'text-emerald-400' : 'text-slate-200'}"
                title="${t('copy_room_code_title')}"
                data-roomcode="${escapeHtml(store.roomCode)}"
              >${store.copiedRoomCode === store.roomCode.trim().toUpperCase() ? t('copied') : `/${escapeHtml(store.roomCode)}`}</button>
              <button id="loadRoom" type="button" class="rounded-md bg-white/10 px-2 py-1 text-sm text-slate-300 hover:bg-white/15">${t('refresh')}</button>
            </div>`
          : `<div class="text-base text-slate-400"></div>`
      }</div>

      ${store.lobbyLoadingMessage ? `<div id="lobbyStatus" class="rounded-md bg-white/5 px-3 py-2 text-base text-slate-300 ring-1 ring-white/10 flex items-center gap-2"><span class="alias-spinner"></span><span>${escapeHtml(store.lobbyLoadingMessage)}</span></div>` : '<div id="lobbyStatus" class="hidden rounded-md bg-white/5 px-3 py-2 text-base text-slate-300 ring-1 ring-white/10"></div>'}
      <div id="lobbyError" class="hidden rounded-md bg-rose-500/10 px-3 py-2 text-base text-rose-200 ring-1 ring-rose-500/20 mt-2"></div>
    </div>
  `
}

function renderHelpCard() {
  const wod = wordOfDay()
  return `
    <h2 class="text-lg font-semibold">${t('rules_title')}</h2>
    <div class="mt-3 rounded-md bg-amber-500/10 px-3 py-2 ring-1 ring-amber-500/20">
      <span class="text-sm font-medium text-amber-200/90">Слово дня</span>
      <div class="mt-0.5 text-xl font-semibold text-amber-100">${escapeHtml(wod)}</div>
    </div>
    <ul class="mt-4 grid gap-2 text-base text-slate-300">
      <li class="rounded-md bg-white/5 px-3 py-2 ring-1 ring-white/10">
        <span class="font-semibold text-slate-100">${t('rules_roles')}</span> ${t('rules_roles_desc')}
      </li>
      <li class="rounded-md bg-white/5 px-3 py-2 ring-1 ring-white/10">
        <span class="font-semibold text-slate-100">${t('rules_points')}</span> ${t('rules_points_desc')}
      </li>
      <li class="rounded-md bg-white/5 px-3 py-2 ring-1 ring-white/10">
        <span class="font-semibold text-slate-100">${t('rules_win')}</span> ${t('rules_win_desc')}
      </li>
      <li class="rounded-md bg-white/5 px-3 py-2 ring-1 ring-white/10">
        <span class="font-semibold text-slate-100">${t('rules_last_word')}</span> ${t('rules_last_word_desc')}
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
          <button type="button" class="alias-mobile-tab rounded-md px-4 py-2.5 text-sm font-semibold transition-colors ${mobileTab === 'team' ? 'bg-white/15 text-white ring-1 ring-white/20' : 'bg-white/5 text-slate-400 ring-1 ring-white/10 hover:bg-white/10'}" data-tab="team">${t('tab_team')}</button>
          <button type="button" class="alias-mobile-tab rounded-md px-4 py-2.5 text-sm font-semibold transition-colors ${mobileTab === 'controls' ? 'bg-white/15 text-white ring-1 ring-white/20' : 'bg-white/5 text-slate-400 ring-1 ring-white/10 hover:bg-white/10'}" data-tab="controls">${t('tab_controls')}</button>
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
    .map((teamRow) => {
      const winner = view.room.winner_team_id === teamRow.id
      const playerNames = (teamRow.player_names ?? []).length
        ? (teamRow.player_names ?? []).map((n) => `<span class="rounded-full bg-white/10 px-2 py-0.5 text-sm text-slate-200 ring-1 ring-white/10">${escapeHtml(n)}</span>`).join('')
        : `<span class="text-sm text-slate-500">${t('spectators_empty')}</span>`
      const base = `
        <div class="min-w-0 flex-1">
          <div class="truncate text-base font-medium text-slate-100">${escapeHtml(teamRow.name)}</div>
          <div class="text-base text-slate-400">${t('round_n', { n: teamRow.round_number })}${teamRow.round_active ? ` ${t('round_active')}` : ''}</div>
          <div class="mt-1.5 flex flex-wrap gap-1">${playerNames}</div>
        </div>
        <div class="ml-auto shrink-0 text-right">
          <div class="text-base font-semibold ${winner ? 'text-emerald-200' : 'text-slate-100'}">${teamRow.score}</div>
          <div class="text-base text-slate-400">${teamRow.total_correct} ${pluralWords(teamRow.total_correct)}</div>
        </div>`
      if (gameStarted) {
        return `<div class="flex items-start gap-2 rounded-md bg-white/5 px-2.5 py-1.5 ring-1 ring-white/10">${base}</div>`
      }
      return `<div role="button" tabindex="0" data-teamcode="${escapeHtml(teamRow.code)}" class="joinTeamBtn flex w-full cursor-pointer items-start gap-2 rounded-md bg-white/5 px-2.5 py-1.5 text-left ring-1 ring-white/10 transition-colors hover:bg-white/10 hover:ring-white/20 focus:outline-none focus:ring-2 focus:ring-indigo-500/60" title="${t('join_team_title')}">${base}</div>`
    })
    .join('')

  return `
    <div class="mt-10">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div class="flex items-center gap-2 text-base text-slate-300">
          <button id="leaveRoom" title="${t('leave_room')}"
            class="inline-flex h-8 w-8 items-center justify-center rounded-md bg-rose-500/90 text-white ring-1 ring-rose-500/30 hover:bg-rose-400">
            <svg viewBox="0 0 24 24" class="h-4 w-4" style="transform: scaleX(-1)" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M10 17l5-5-5-5" />
              <path d="M15 12H3" />
              <path d="M21 5v14a2 2 0 0 1-2 2h-6" />
              <path d="M13 3h6a2 2 0 0 1 2 2z" />
            </svg>
          </button>
          <div class="flex items-center gap-2">
            <span>${t('room')}</span>
            <button
              type="button"
              class="copyRoomCode inline-flex items-center gap-1 font-mono tracking-widest underline decoration-dotted underline-offset-4 hover:text-white focus:outline-none focus:ring-2 focus:ring-indigo-500/60 ${store.copiedRoomCode === view.room.code ? 'text-emerald-400' : 'text-slate-100'}"
              title="${t('copy_room_code_title')}"
              data-roomcode="${escapeHtml(view.room.code)}"
            >${store.copiedRoomCode === view.room.code ? t('copied') : `/${escapeHtml(view.room.code)}`}</button>
            <div id="roomQrWrap" class="alias-room-qr flex shrink-0" data-roomcode="${escapeHtml(view.room.code)}" title="QR: jarusdev.com/${escapeHtml(view.room.code)}">
              <img id="roomQrImg" alt="QR в комнату" width="56" height="56" class="rounded border border-white/10 bg-white" />
            </div>
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
    <button id="addTeamBtn" title="${t('add_team_btn')}"
      class="inline-flex h-10 w-10 items-center justify-center rounded-md bg-emerald-500 text-xl font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-50"
      ${store.playerId ? '' : 'disabled'}>
      +
    </button>
  `

  return `
    <div class="mt-4 grid gap-2">
      <div class="text-base text-slate-400">${t('teams_create_hint')}</div>
      <div class="grid gap-2">
        ${teamButtons || `<div class="text-base text-slate-300">${t('no_teams_yet')}</div>`}
      </div>
      <div class="mt-1 flex items-center gap-2">
        ${plus}
        ${teams.length ? `<div class="text-base text-slate-400">${t('and_create_next')}</div>` : ''}
      </div>
    </div>
  `
}

function renderMyTeamPanel(view: WsView) {
  if (!view.me.team_id) {
    return `
      <div class="flex items-start justify-between gap-2">
        <div>
          <div class="text-base font-semibold">${t('teams')}</div>
          <div class="mt-1 text-base text-slate-400">${t('in_room_no_team')}</div>
        </div>
      </div>
      ${renderTeamChooser(view)}
      <div id="teamError" class="mt-3 hidden rounded-md bg-rose-500/10 px-3 py-2 text-base text-rose-200 ring-1 ring-rose-500/20"></div>
    `
  }

  const team = view.my_team
  if (!team) return `<div class="text-base text-slate-300">${t('no_team')}</div>`

  const isCluegiver = view.me.role === 'cluegiver' && team.cluegiver_id === view.me.id
  const gameStarted = (view.room.teams ?? []).some((t) => t.round_number > 0) && !view.room.game_over
  const roleDisabled = gameStarted
  const roleClueLabel = t('role_clue')
  const roleGuessLabel = t('role_guess')
  const roleBadge = isCluegiver
    ? `<span class="rounded-full bg-indigo-500/20 px-2 py-1 text-base text-indigo-200 ring-1 ring-indigo-500/30">${escapeHtml(roleClueLabel)}</span>`
    : `<span class="rounded-full bg-white/10 px-2 py-1 text-base text-slate-200 ring-1 ring-white/10">${escapeHtml(roleGuessLabel)}</span>`

  const players = team.players
    .map((p) => {
      const isClue = team.cluegiver_id === p.id
      return `<div class="flex items-center justify-between gap-2 rounded-md bg-white/5 px-3 py-2 ring-1 ring-white/10">
        <div class="min-w-0">
          <div class="truncate text-base font-medium text-slate-100">${escapeHtml(p.name)}</div>
          <div class="text-base text-slate-400">${p.role === 'cluegiver' ? roleClueLabel : roleGuessLabel}</div>
        </div>
        ${isClue ? `<span class="shrink-0 rounded-full bg-indigo-500/20 px-2 py-1 text-base text-indigo-200 ring-1 ring-indigo-500/30">${escapeHtml(roleClueLabel)}</span>` : ''}
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
      <div class="text-base text-slate-300">${t('your_role')} ${roleBadge}</div>
      <button id="toggleRoleBtn" title="${roleDisabled ? t('role_locked') : ''}"
        class="w-full rounded-md bg-white/10 px-3 py-2 text-base font-semibold text-white ring-1 ring-white/10 hover:bg-white/15 disabled:opacity-50"
        ${roleDisabled ? 'disabled' : ''}>
        ${isCluegiver ? t('become_guesser') : t('become_cluegiver')}
      </button>
    </div>
    <div class="mt-4 grid gap-2">
      <div class="text-base text-slate-400">${t('players')}</div>
      ${players || `<div class="text-base text-slate-300">${t('no_players_yet')}</div>`}
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
    const myTeam = view.me.team_id ? teams.find((t) => t.id === view.me.team_id) : null
    const canShare = !!myTeam
    const shareBtn = canShare
      ? `<button id="shareResultBtn" type="button" class="mt-4 w-full rounded-md bg-white/10 px-4 py-3 text-base font-semibold text-white ring-1 ring-white/10 hover:bg-white/15 transition-opacity inline-flex items-center justify-center gap-2">
            <svg class="h-5 w-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" stroke-linecap="round" stroke-linejoin="round"/></svg>
            ${t('share_result_btn')}
          </button>`
      : ''

    return `
      <div class="alias-game-over-wrap text-base text-slate-300">${t('game_over')}</div>
      <div class="alias-game-over-confetti relative mt-3 overflow-hidden rounded-md bg-emerald-500/10 py-6 px-5 ring-2 ring-emerald-500/30">
        <div class="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">${confettiPieces}</div>
        <div class="relative">
          <div class="text-center text-sm font-medium text-emerald-200/90">${t('winner')}</div>
          <div class="alias-game-over-winner mt-2 text-center text-4xl font-bold tracking-tight text-emerald-50 drop-shadow-[0_0_20px_rgba(16,185,129,0.4)] sm:text-5xl">${escapeHtml(winner?.name ?? '—')}</div>
          <div class="mt-5 grid gap-2">${teamsList}</div>
        </div>
      </div>
      ${shareBtn}
      ${
        canRestart
          ? `<button id="restartGame" class="mt-4 w-full rounded-md bg-white/10 px-4 py-3 text-base font-semibold text-white ring-1 ring-white/10 hover:bg-white/15 transition-opacity">
              ${t('restart_game')}
            </button>`
          : ''
      }
    `
  }

  if (!view.me.team_id) {
    return `
      <div class="text-base font-semibold">${t('game_screen')}</div>
      <div class="mt-1 text-base text-slate-300">${t('choose_team_or_create')}</div>
      <div class="mt-6 rounded-md bg-white/5 p-7 ring-1 ring-white/10">
        <div class="text-base text-slate-300">${t('guess_fields')}</div>
        <div class="mt-3 text-base text-slate-400">${t('empty_not_in_team')}</div>
      </div>
    `
  }

  const team = view.my_team
  if (!team) return `<div class="text-base text-slate-300">${t('no_team_data')}</div>`

  const activeTeam = view.active_team ?? null
  const myTeamIsPlaying = team.round_active
  const showAsGuesser = !myTeamIsPlaying
  const displayRemain = displayRemainingSeconds(view)
  const timeExpired = displayRemain !== null && displayRemain <= 0
  const timer =
    displayRemain === null
      ? `<div class="text-base text-slate-400">${t('round_not_active')}</div>`
      : myTeamIsPlaying
        ? `<div class="text-base text-slate-300">${t('round_remaining', { n: team.round_number })} <span id="roundTimerValue" class="font-semibold text-slate-100">${displayRemain}s</span>${t('time_left_suffix') ? ' ' + t('time_left_suffix') : ''}</div>`
        : `<div class="text-base text-slate-300">${t('timer')}: <span id="roundTimerValue" class="font-semibold text-slate-100">${displayRemain}s</span></div>`

  const isCluegiver = view.me.role === 'cluegiver' && team.cluegiver_id === view.me.id
  const showCluegiverUI = isCluegiver && myTeamIsPlaying

  if (showCluegiverUI) {
    const currentWord = team.current_word ?? '…'
    const lastWordHint = timeExpired ? `<div class="mt-2 text-base text-amber-200/90">${t('time_up_mark_last')}</div>` : ''
    return `
      <div class="flex items-center justify-between gap-3">
        <div>
          <div class="text-base text-slate-300">${t('you_cluegiver')}</div>
          ${timer}
          ${lastWordHint}
        </div>
        <div class="text-base text-slate-300">${t('score')}: <span class="font-semibold text-slate-100">${team.score}</span></div>
      </div>

      <div class="mt-6 rounded-xl bg-gradient-to-br from-amber-950/30 via-slate-700/25 to-slate-800/40 p-5 ring-1 ring-white/10 flex flex-col min-h-[140px] sm:min-h-[180px]">
        <div class="text-xs font-medium uppercase tracking-[0.18em] text-slate-400">${t('current_word')}</div>
        <div class="mt-2 flex flex-1 items-center justify-center">
          <div class="alias-word-appear text-center text-4xl sm:text-5xl font-semibold tracking-tight text-white">${escapeHtml(currentWord)}</div>
        </div>
      </div>

      <div class="mt-5 alias-outcome-buttons rounded-md p-3 ring-1 ring-white/10 ${timeExpired ? 'alias-outcome-buttons-expired' : ''}">
        <div class="grid gap-3 sm:grid-cols-3">
          <button id="markCorrect" class="rounded-md bg-emerald-500 px-4 py-3 text-base font-semibold text-emerald-950 hover:bg-emerald-400 disabled:opacity-50" ${
          team.round_active ? '' : 'disabled'
        } title="${t('key_1')}">
            ${t('mark_correct')}
          </button>
          <button id="markDontKnow" class="rounded-md bg-white/10 px-4 py-3 text-base font-semibold text-white ring-1 ring-white/10 hover:bg-white/15 disabled:opacity-50" ${
          team.round_active ? '' : 'disabled'
        } title="${t('key_2')}">
            ${t('mark_dont_know')}
          </button>
          <button id="markSkip" class="rounded-md bg-rose-500/90 px-4 py-3 text-base font-semibold text-white hover:bg-rose-400 disabled:opacity-50" ${
          team.round_active ? '' : 'disabled'
        } title="${t('key_3')}">
            ${t('mark_skip')}
          </button>
        </div>
      </div>
      <p class="mt-2 text-center text-sm text-slate-500">${t('hotkeys_hint')}</p>

      <div class="mt-4 rounded-md bg-white/5 px-3 py-2 text-base text-slate-300 ring-1 ring-white/10">
        ${t('last_revealed')}: <span class="font-semibold text-slate-100">${escapeHtml(team.last_revealed_word ?? '—')}</span>
      </div>

      <div id="gameError" class="mt-3 hidden rounded-md bg-rose-500/10 px-3 py-2 text-base text-rose-200 ring-1 ring-rose-500/20"></div>
    `
  }

  const guesserTimerExpiredHint = timeExpired ? `<div class="mt-2 text-base text-amber-200/90">${t('time_up_wait_clue')}</div>` : ''
  const historyTeam = activeTeam && activeTeam.id !== team.id ? (activeTeam as TeamPrivateView) : team
  const historyTitle = activeTeam && activeTeam.id !== team.id
    ? `${t('now_playing')}: ${escapeHtml(activeTeam.name)}`
    : t('word_history')
  const waitingHint = showAsGuesser && activeTeam && activeTeam.id !== team.id
    ? `<div class="mt-1 text-base text-slate-400">${t('waiting_other_team')}</div>`
    : ''
  const roleLabel = isCluegiver && !myTeamIsPlaying ? t('you_cluegiver') : t('you_guesser')
  return `
    <div class="text-base text-slate-300">${roleLabel}${waitingHint}</div>
    ${timer}
    ${myTeamIsPlaying ? guesserTimerExpiredHint : (displayRemain !== null && displayRemain <= 0 ? `<div class="mt-2 text-base text-amber-200/90">${t('time_up_wait_clue')}</div>` : '')}
    <div class="mt-6 rounded-md bg-white/5 p-7 ring-1 ring-white/10">
      <div class="text-base text-slate-300">${historyTitle}</div>
      <div class="mt-3 max-h-[510px] overflow-y-auto pr-1">
        ${renderRoundHistory(historyTeam, true, !team.round_active && historyTeam === team, store.pendingWordOutcome)}
      </div>
    </div>
    <div id="gameError" class="mt-3 hidden rounded-md bg-rose-500/10 px-3 py-2 text-base text-rose-200 ring-1 ring-rose-500/20"></div>
  `
}

function renderRightPanel(view: WsView) {
  const canSettings = canEditSettings(view)
  const cfg = store.settingsDraft ?? view.room.config
  const team = view.my_team
  const remain = displayRemainingSeconds(view)
  const gameStarted = (view.room.teams ?? []).some((t) => t.round_number > 0) && !view.room.game_over

  const dice = `
    <button id="randomizeBtn" title="${t('randomize_teams')}"
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
        ${t('settings')}
      </span>
    </button>
  `

  const canChangeWordPack = !gameStarted
  const hasCustomPack = !!view.room.custom_words_name
  const wordPackSelect =
    hasCustomPack
      ? `<div class="grid gap-1">
          <span class="text-base text-slate-300">${t('word_pack_label')}</span>
          <div class="rounded-md bg-white/5 px-3 py-2 text-base text-slate-200 ring-1 ring-white/10">Свой: ${escapeHtml(view.room.custom_words_name ?? '')}</div>
        </div>`
      : `
        <label class="grid gap-1">
          <span class="text-base text-slate-300">${t('word_pack_label')}</span>
          <select id="cfgWordPack" class="rounded-md bg-white/5 px-3 py-2 text-base ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-500/60" ${canSettings && canChangeWordPack ? '' : 'disabled'} title="${!canChangeWordPack ? t('word_pack_locked') : ''}">
            <option value="simple" ${(cfg.word_pack ?? 'medium') === 'simple' ? 'selected' : ''}>${t('word_pack_simple')}</option>
            <option value="medium" ${(cfg.word_pack ?? 'medium') === 'medium' ? 'selected' : ''}>${t('word_pack_medium')}</option>
            <option value="hard" ${(cfg.word_pack ?? 'medium') === 'hard' ? 'selected' : ''}>${t('word_pack_hard')}</option>
          </select>
        </label>`

  const wordPackLangSelect = !hasCustomPack
    ? `
        <label class="grid gap-1">
          <span class="text-base text-slate-300">${escapeHtml(t('word_pack_lang_label'))}</span>
          <select id="cfgWordPackLang" class="rounded-md bg-white/5 px-3 py-2 text-base ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-500/60" ${canSettings && canChangeWordPack ? '' : 'disabled'}>
            ${LOCALES.map((loc) => `<option value="${loc.code}" ${(cfg.word_pack_lang ?? 'ru') === loc.code ? 'selected' : ''}>${escapeHtml(loc.native)}</option>`).join('')}
          </select>
        </label>`
    : ''

  const canRestartInGame = view.me.role === 'cluegiver' && !!view.me.team_id
  const restartInSettingsBtn =
    canRestartInGame
      ? `<button id="restartGameInSettings" type="button" class="mt-3 w-full rounded-md bg-amber-500/20 px-4 py-3 text-base font-semibold text-amber-200 ring-1 ring-amber-500/30 hover:bg-amber-500/30">
          ${t('restart_game')}
        </button>`
      : ''

  const settings =
    store.settingsOpen
      ? `
      <div class="mt-4 grid gap-3">
        ${wordPackSelect}
        ${wordPackLangSelect}

        <label class="grid gap-1">
          <span class="text-base text-slate-300">${t('win_type')}</span>
          <select id="cfgMode" class="rounded-md bg-white/5 px-3 py-2 text-base ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-500/60" ${
              canSettings ? '' : 'disabled'
            }>
              <option value="to_words" ${cfg.mode === 'to_words' ? 'selected' : ''}>По количеству угаданных слов</option>
              <option value="to_rounds" ${cfg.mode === 'to_rounds' ? 'selected' : ''}>По количеству раундов</option>
            </select>
        </label>

        <label class="flex cursor-pointer items-center gap-3 rounded-md bg-white/5 px-3 py-2.5 ring-1 ring-white/10 transition-colors hover:bg-white/[0.07] focus-within:ring-2 focus-within:ring-indigo-500/60" for="cfgAnyoneEdit">
          <input id="cfgAnyoneEdit" type="checkbox" class="alias-settings-checkbox" ${cfg.only_cluegiver_can_edit_settings === false ? 'checked' : ''} ${canSettings ? '' : 'disabled'} />
          <span class="text-base text-slate-300">${t('settings_allow_anyone_edit')}</span>
        </label>

        <div class="grid gap-3 sm:grid-cols-2">
          <label class="grid gap-1">
            <span class="text-base text-slate-300">${t('round_seconds')}</span>
            <input id="cfgRoundSec" type="number" min="${CONFIG_ROUND_SEC_MIN}" max="${CONFIG_ROUND_SEC_MAX}" value="${(cfg as SettingsDraft)._roundSecEmpty ? '' : cfg.round_seconds}"
              class="rounded-md bg-white/5 px-3 py-2 text-base ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-500/60" ${canSettings ? '' : 'disabled'} />
          </label>
          <label class="grid gap-1">
            <span id="cfgTargetLabel" class="text-base text-slate-300">${cfg.mode === 'to_words' ? t('words_to_win') : t('rounds_to_win')}</span>
            <input id="cfgTarget" type="number" min="${cfg.mode === 'to_words' ? CONFIG_TARGET_WORDS_MIN : CONFIG_MAX_ROUNDS_MIN}" max="${cfg.mode === 'to_words' ? CONFIG_TARGET_WORDS_MAX : CONFIG_MAX_ROUNDS_MAX}" value="${(cfg as SettingsDraft)._targetEmpty ? '' : (cfg.mode === 'to_words' ? cfg.target_words : cfg.max_rounds)}"
              class="rounded-md bg-white/5 px-3 py-2 text-base ring-1 ring-white/10 focus:outline-none focus:ring-2 focus:ring-indigo-500/60" ${canSettings ? '' : 'disabled'} />
            </label>
          </div>
        ${restartInSettingsBtn}
      </div>
    `
      : ''

  const activeTeam = view.active_team ?? null
  const teamsList = view.room.teams ?? []
  const canStartRoundTeamId = view.can_start_round_team_id ?? null
  const fallbackNextIndex = teamsList.length ? (teamsList.reduce((s, t) => s + t.round_number, 0) % teamsList.length) : 0
  const effectiveCanStartId = canStartRoundTeamId ?? teamsList[fallbackNextIndex]?.id ?? null
  const canMyTeamStart = !!(team && effectiveCanStartId && String(team.id) === String(effectiveCanStartId))
  const otherTeamPlaying = !!(activeTeam && team && activeTeam.id !== team.id)
  const canPressStartRound = canMyTeamStart && !otherTeamPlaying
  const startRoundTitle = !canPressStartRound && team && !team.round_active && teamsList.length > 1
    ? (otherTeamPlaying ? t('another_team_round_active') : t('not_your_turn'))
    : ''

  const controls =
    view.me.role === 'cluegiver' && view.me.team_id
      ? `
      <div class="mt-4 grid gap-3 sm:grid-cols-2">
        <button id="startRound" class="rounded-md bg-indigo-500 px-4 py-3 text-base font-semibold text-white hover:bg-indigo-400 disabled:opacity-50" ${
          team && !team.round_active && !view.room.game_over && canPressStartRound ? '' : 'disabled'
        } title="${startRoundTitle}">
          ${t('start_round')}
        </button>
        <button id="endRound" class="rounded-md bg-rose-500/90 px-4 py-3 text-base font-semibold text-white hover:bg-rose-400 disabled:opacity-50" ${
          team && team.round_active && !view.room.game_over && !(remain !== null && remain <= 0 && (team.current_word ?? null)) ? '' : 'disabled'
        } title="${team && remain !== null && remain <= 0 && (team.current_word ?? null) ? t('end_round_mark_first') : ''}">
          ${t('end_round')}
        </button>
      </div>
      `
      : ''

  const isCluegiver = view.me.role === 'cluegiver'
  const myTeamIsPlaying = team?.id != null && activeTeam?.id === team.id
  const showMyTeamHistory = team && isCluegiver && myTeamIsPlaying

  const history =
    showMyTeamHistory
      ? `
      <div class="mt-6 rounded-md bg-white/5 p-5 ring-1 ring-white/10">
        <div class="text-base text-slate-300">${t('word_history')}</div>
        <div class="mt-3 max-h-[510px] overflow-y-auto pr-1">
          ${renderRoundHistory(team, true, !team.round_active, store.pendingWordOutcome)}
        </div>
      </div>
    `
      : ''

  return `
    <div class="flex items-start justify-between gap-3">
      <div>
        <div class="text-base font-semibold">${t('controls')}</div>
        ${remain === null ? '' : `<div class="mt-1 text-base text-slate-400">${t('timer')}: <span id="roundTimerValue2">${remain}s</span></div>`}
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

function renderRoundHistory(team: TeamPrivateView, onlyCurrent: boolean, editable = false, pendingOutcome = false) {
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
                const sel = (o: string) => (editable && e.outcome === o ? ' ring-2 ring-white ring-offset-2 ring-offset-slate-800 font-semibold' : '')
                const dis = pendingOutcome ? ' disabled' : ''
                const buttons =
                  editable
                    ? `<div class="flex flex-wrap gap-1" data-round-index="${roundIdx}" data-word-index="${wordIdx}">
                        <button type="button" class="setWordOutcomeBtn rounded-md bg-emerald-500/80 px-2 py-1 text-sm text-white hover:bg-emerald-400 disabled:opacity-50${sel('correct')}" data-outcome="correct"${dis}>+1</button>
                        <button type="button" class="setWordOutcomeBtn rounded-md bg-white/10 px-2 py-1 text-sm text-slate-200 ring-1 ring-white/10 hover:bg-white/20 disabled:opacity-50${sel('dont_know')}" data-outcome="dont_know"${dis}>0</button>
                        <button type="button" class="setWordOutcomeBtn rounded-md bg-rose-500/80 px-2 py-1 text-sm text-white hover:bg-rose-400 disabled:opacity-50${sel('skip')}" data-outcome="skip"${dis}>−1</button>
                      </div>`
                    : tag
                const isLastCorrect = wordIdx === events.length - 1 && e.outcome === 'correct'
                const liClass = `flex items-center justify-between gap-3 rounded-md bg-white/5 px-3 py-2 ring-1 ring-white/10${isLastCorrect ? ' alias-last-correct-pulse' : ''}`
                return `<li class="${liClass}">
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
    log('error', 'sendWs: нет подключения', { type: (obj as { type?: string })?.type })
    return
  }
  const msg = obj as { type?: string }
  log('ws', '→ отправка', { type: msg.type, payload: msg })
  store.ws.send(JSON.stringify(obj))
}

async function connectWs(force: boolean) {
  if (!store.playerId) return
  if (!force && store.ws && (store.ws.readyState === WebSocket.OPEN || store.ws.readyState === WebSocket.CONNECTING)) return
  store.ws?.close()
  store.ws = null
  const wsUrl = `${API_BASE.replace('http', 'ws')}/ws`
  log('ws', 'подключение', { url: wsUrl, playerId: store.playerId })
  const ws = new WebSocket(wsUrl)
  store.ws = ws
  ws.onopen = () => {
    log('ws', 'соединение открыто, отправка hello', { player_id: store.playerId })
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
        const v = data.view
        log('state', '← state', {
          room: v.room?.code,
          game_over: v.room?.game_over,
          me: { role: v.me?.role, team_id: v.me?.team_id ? '…' : null },
          teams: v.room?.teams?.map((t) => ({ name: t.name, round_number: t.round_number, round_active: t.round_active })),
          can_start_round_team_id: v.can_start_round_team_id ?? null,
          my_team_round_active: v.my_team?.round_active,
          active_team: v.active_team?.name ?? null,
        })
        const prevGameOver = store.view?.room?.game_over
        store.view = data.view
        store.pendingWordOutcome = false
        // После перезапуска игры сервер переводит всех в «Игроки без команды» — синхронизируем store.teamCode
        if (!data.view.me.team_id) {
          store.teamCode = ''
          save()
        }
        if (store.settingsDraft && configKey(toEffectiveConfig(store.settingsDraft, data.view.room.config)) === configKey(data.view.room.config)) store.settingsDirty = false
        if (!store.settingsDirty) store.settingsDraft = data.view.room.config
        if (!prevGameOver && data.view.room.game_over && data.view.room.winner_team_id != null) {
          const myTeamId = data.view.me.team_id
          if (myTeamId === data.view.room.winner_team_id) playWin()
          else if (myTeamId != null) playLose()
        }
        render()
      } else if (data.type === 'player_left') {
        log('room', 'игрок вышел', { player_name: (data as WsPlayerLeft).player_name })
        showToastLeave(`${escapeHtml((data as WsPlayerLeft).player_name)} покинул комнату`)
      } else if ((data as WsLeft).type === 'left') {
        log('ws', '← left (выход из комнаты)')
        leaveRoomToLobby()
      } else {
        const err = data as WsError
        store.pendingWordOutcome = false
        log('error', '← ошибка от сервера', { message: err.message })
        const msg =
          err.message === 'cannot_change_settings_after_game_started' ||
          err.message === 'cannot_change_word_pack_after_game_started'
            ? t('cannot_change_settings_after_game_started')
            : err.message === 'cannot_change_win_condition_after_game_started'
              ? t('cannot_change_win_condition')
              : err.message === 'not_your_turn'
                ? t('not_your_turn')
                : err.message === 'another_team_round_active'
                  ? t('another_team_round_active')
                  : err.message
        setError('rightError', msg)
        if (err.message === 'not_your_turn' || err.message === 'another_team_round_active') showToast(msg)
      }
    } catch {
      // ignore
    }
  }
  ws.onclose = () => {
    log('ws', 'соединение закрыто')
    store.ws = null
    // Если будем автопереподключаться — сразу показываем «Подключается», чтобы не мигало «Не подключено»
    const willReconnect = Boolean(store.playerId && store.playerRoomCode && store.reconnectTimerId == null)
    store.connecting = willReconnect
    render()
    if (willReconnect) {
      const delay = Math.min(1000 * Math.pow(2, store.reconnectAttempt), 30000)
      store.reconnectAttempt = Math.min(store.reconnectAttempt + 1, 10)
      store.reconnectTimerId = window.setTimeout(() => {
        store.reconnectTimerId = null
        void connectWs(true)
      }, delay)
    }
  }
  ws.onerror = () => {
    log('error', 'WebSocket error')
    store.connecting = false
    setError('lobbyError', 'Не удалось подключиться к WebSocket. Проверьте, что бэкенд запущен на порту 8000.')
    render()
  }
}

function updateTargetLabel(mode: GameMode) {
  const el = document.getElementById('cfgTargetLabel')
  if (!el) return
  el.textContent = mode === 'to_words' ? t('words_to_win') : t('rounds_to_win')
}

function updateDraftFromUi() {
  const modeEl = document.getElementById('cfgMode') as HTMLSelectElement | null
  const roundSecEl = document.getElementById('cfgRoundSec') as HTMLInputElement | null
  const targetEl = document.getElementById('cfgTarget') as HTMLInputElement | null
  const wordPackEl = document.getElementById('cfgWordPack') as HTMLSelectElement | null
  const wordPackLangEl = document.getElementById('cfgWordPackLang') as HTMLSelectElement | null
  const anyoneEditEl = document.getElementById('cfgAnyoneEdit') as HTMLInputElement | null
  if (!modeEl || !roundSecEl || !targetEl || !store.view) return

  const base = store.settingsDraft ?? store.view.room.config
  const mode = modeEl.value as GameMode
  const roundSecEmpty = roundSecEl.value.trim() === ''
  const round_seconds = roundSecEmpty ? base.round_seconds : Math.max(CONFIG_ROUND_SEC_MIN, Math.min(CONFIG_ROUND_SEC_MAX, Number(roundSecEl.value) || base.round_seconds))
  const targetEmpty = targetEl.value.trim() === ''
  const targetRaw = targetEmpty ? (mode === 'to_words' ? base.target_words : base.max_rounds) : (Number(targetEl.value) || (mode === 'to_words' ? base.target_words : base.max_rounds))
  const targetWords = mode === 'to_words' ? Math.max(CONFIG_TARGET_WORDS_MIN, Math.min(CONFIG_TARGET_WORDS_MAX, targetRaw)) : base.target_words
  const maxRounds = mode === 'to_rounds' ? Math.max(CONFIG_MAX_ROUNDS_MIN, Math.min(CONFIG_MAX_ROUNDS_MAX, targetRaw)) : base.max_rounds
  const word_pack = (wordPackEl?.value as WordPack) ?? (base.word_pack ?? 'medium')
  const word_pack_lang = (wordPackLangEl?.value as WordPackLang) ?? (base.word_pack_lang ?? 'ru')
  const only_cluegiver_can_edit_settings = anyoneEditEl ? !anyoneEditEl.checked : (base.only_cluegiver_can_edit_settings !== false)

  const draft: SettingsDraft = {
    mode,
    round_seconds,
    target_words: targetWords,
    max_rounds: maxRounds,
    word_pack,
    word_pack_lang,
    only_cluegiver_can_edit_settings,
    _roundSecEmpty: roundSecEmpty,
    _targetEmpty: targetEmpty,
  }
  store.settingsDraft = draft
  const effective = toEffectiveConfig(draft, store.view.room.config)
  store.settingsDirty = store.view ? configKey(effective) !== configKey(store.view.room.config) : false
  updateTargetLabel(mode)
  render()
}

function applyDraftSettings() {
  if (!store.view || !store.settingsDraft) return
  if (!canEditSettings(store.view)) return
  const effective = toEffectiveConfig(store.settingsDraft, store.view.room.config)
  store.settingsDirty = configKey(effective) !== configKey(store.view.room.config)
  if (!store.settingsDirty) return
  log('action', 'применение настроек', { config: effective })
  sendWs({ type: 'update_settings', config: effective })
  showToast(t('settings_applied'))
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
    log('room', 'переподключение к комнате', { room_code: code })
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
    log('room', 'вход в комнату', { room_code: code, player_name: name })
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
  log('room', 'выход из комнаты в лобби')
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
    log('room', 'комната создана', { room_code: data.room_code })
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
    log('team', 'вступил в команду', { team_code: team_code.toUpperCase(), role })
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
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: t('team_default_name', { n }) }) },
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
  log('action', 'перезапуск игры', { room_code: roomCode })
  try {
    setError('rightError', null)
    const data = await fetchJson<{ ok: boolean; view?: WsView }>(
      `${API_BASE}/api/rooms/${roomCode}/players/${store.playerId}/restart`,
      { method: 'POST' },
      6000,
    )
    if (data.view) {
      store.view = data.view
      if (store.settingsDraft && configKey(store.settingsDraft) === configKey(data.view.room.config)) store.settingsDirty = false
      if (!store.settingsDirty) store.settingsDraft = data.view.room.config
      render()
    }
    showToast(t('game_restarted'))
  } catch (e) {
    setError('rightError', apiErrorMessage((e as Error).message))
    showToast(t('restart_failed'))
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

  ;(document.getElementById('dismissFirstVisit') as HTMLButtonElement | null)?.addEventListener('click', () => {
    store.firstVisitDone = true
    try {
      localStorage.setItem('alias_first_visit_done', '1')
    } catch {
      // ignore
    }
    render()
  })

  ;(document.getElementById('createRoom') as HTMLButtonElement | null)?.addEventListener('click', () => void createRoom())
  ;(document.getElementById('loadRoom') as HTMLButtonElement | null)?.addEventListener('click', () => void loadRoomInfo())
  ;(document.getElementById('enterRoom') as HTMLButtonElement | null)?.addEventListener('click', () => void ensureJoinedSpectator(store.roomCode))
  ;(document.getElementById('leaveRoom') as HTMLButtonElement | null)?.addEventListener('click', () => {
    log('room', 'клик: Выйти из комнаты')
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
        errMsg === 'cannot_change_settings_after_game_started' ||
        errMsg === 'cannot_change_word_pack_after_game_started'
          ? t('cannot_change_settings_after_game_started')
          : errMsg === 'cannot_change_win_condition_after_game_started'
            ? t('cannot_change_win_condition')
            : apiErrorMessage(errMsg),
      )
    }
  })

  // copyRoomCode обрабатывается через делегирование в init (чтобы работало и после частичного обновления поля кода комнаты)

  ;(document.getElementById('themeToggle') as HTMLButtonElement | null)?.addEventListener('click', () => {
    store.theme = store.theme === 'dark' ? 'light' : 'dark'
    try {
      localStorage.setItem('alias_theme', store.theme)
    } catch {
      // ignore
    }
    applyTheme()
    render()
  })

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

  ;(document.getElementById('shareResultBtn') as HTMLButtonElement | null)?.addEventListener('click', () => {
    const view = store.view
    if (!view?.room?.game_over || !view.me.team_id) return
    const myTeam = view.room.teams?.find((t) => t.id === view.me.team_id)
    if (!myTeam) return
    store.shareModalOpen = true
    store.shareCardPreviewUrl = null
    store.shareCardBlob = null
    render()
    const params: ShareCardParams = {
      isWinner: view.room.winner_team_id === view.me.team_id,
      teamName: myTeam.name,
      scoreLabel: `${myTeam.score} ${pluralPoints(myTeam.score)}`,
      titleWon: t('share_we_won'),
      titleLost: t('share_we_lost'),
      brandText: t('share_brand'),
    }
    drawShareCard(params)
      .then((blob) => {
        if (store.shareCardPreviewUrl) URL.revokeObjectURL(store.shareCardPreviewUrl)
        store.shareCardBlob = blob
        store.shareCardPreviewUrl = URL.createObjectURL(blob)
        render()
      })
      .catch(() => {
        store.shareModalOpen = false
        render()
      })
  })

  ;(document.getElementById('shareModalBackdrop') as HTMLElement | null)?.addEventListener('click', () => {
    if (store.shareCardPreviewUrl) URL.revokeObjectURL(store.shareCardPreviewUrl)
    store.shareModalOpen = false
    store.shareCardPreviewUrl = null
    store.shareCardBlob = null
    render()
  })
  ;(document.getElementById('shareModalClose') as HTMLButtonElement | null)?.addEventListener('click', () => {
    if (store.shareCardPreviewUrl) URL.revokeObjectURL(store.shareCardPreviewUrl)
    store.shareModalOpen = false
    store.shareCardPreviewUrl = null
    store.shareCardBlob = null
    render()
  })
  ;(document.getElementById('shareModalDownload') as HTMLButtonElement | null)?.addEventListener('click', () => {
    if (store.shareCardBlob) {
      shareCardBlobAsFile(store.shareCardBlob, 'alias-result.png')
      showToast(t('share_download'))
    }
  })
  ;(document.getElementById('shareModalShare') as HTMLButtonElement | null)?.addEventListener('click', async () => {
    if (!store.shareCardBlob) return
    const file = new File([store.shareCardBlob], 'alias-result.png', { type: 'image/png' })
    if (navigator.share && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({
          title: t('share_brand'),
          text: store.view?.room?.winner_team_id === store.view?.me?.team_id ? t('share_we_won') : t('share_we_lost'),
          files: [file],
        })
        showToast(t('share_share'))
      } catch (e) {
        if ((e as Error).name !== 'AbortError') shareCardBlobAsFile(store.shareCardBlob!, 'alias-result.png')
      }
    } else {
      shareCardBlobAsFile(store.shareCardBlob, 'alias-result.png')
      showToast(t('share_download'))
    }
  })

  // joinTeamBtn и becomeSpectatorBtn обрабатываются через делегирование в init

  ;(document.getElementById('startRound') as HTMLButtonElement | null)?.addEventListener('click', () => {
    log('round', 'клик: Старт раунда')
    sendWs({ type: 'start_round' })
  })
  ;(document.getElementById('endRound') as HTMLButtonElement | null)?.addEventListener('click', () => {
    log('round', 'клик: Завершить раунд')
    sendWs({ type: 'end_round' })
  })

  ;(document.getElementById('markCorrect') as HTMLButtonElement | null)?.addEventListener('click', () => {
    log('word', 'отметка: Угадал (+1)')
    playCorrect()
    sendWs({ type: 'mark', outcome: 'correct' })
  })
  ;(document.getElementById('markDontKnow') as HTMLButtonElement | null)?.addEventListener('click', () => {
    log('word', 'отметка: Не знаю (0)')
    playDontKnow()
    sendWs({ type: 'mark', outcome: 'dont_know' })
  })
  ;(document.getElementById('markSkip') as HTMLButtonElement | null)?.addEventListener('click', () => {
    log('word', 'отметка: Пропуск (-1)')
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
    if (store.pendingWordOutcome) return
    store.pendingWordOutcome = true
    render()
    log('word', 'изменение очка за слово', { round_index: roundIndex, word_index: wordIndex, outcome })
    setError('rightError', null)
    sendWs({ type: 'set_word_outcome', round_index: roundIndex, word_index: wordIndex, outcome })
  })

  const modeEl = document.getElementById('cfgMode') as HTMLSelectElement | null
  const roundSecEl = document.getElementById('cfgRoundSec') as HTMLInputElement | null
  const targetEl = document.getElementById('cfgTarget') as HTMLInputElement | null
  const wordPackEl = document.getElementById('cfgWordPack') as HTMLSelectElement | null
  const wordPackLangEl = document.getElementById('cfgWordPackLang') as HTMLSelectElement | null
  const anyoneEditEl = document.getElementById('cfgAnyoneEdit') as HTMLInputElement | null

  function syncDraftAndApply() {
    updateDraftFromUi()
    applyDraftSettings()
  }

  modeEl?.addEventListener('change', syncDraftAndApply)
  wordPackEl?.addEventListener('change', syncDraftAndApply)
  wordPackLangEl?.addEventListener('change', syncDraftAndApply)
  anyoneEditEl?.addEventListener('change', syncDraftAndApply)
  roundSecEl?.addEventListener('input', updateDraftFromUi)
  targetEl?.addEventListener('input', updateDraftFromUi)
  roundSecEl?.addEventListener('blur', syncDraftAndApply)
  targetEl?.addEventListener('blur', syncDraftAndApply)

  // QR комнаты: генерируем после рендера, один раз на код комнаты
  const roomQrWrap = document.getElementById('roomQrWrap')
  const roomQrImg = document.getElementById('roomQrImg')
  if (roomQrWrap && roomQrImg && roomQrImg instanceof HTMLImageElement) {
    const code = roomQrWrap.getAttribute('data-roomcode')
    if (code && roomQrImg.dataset.qrCode !== code) {
      const url = `https://jarusdev.com/${code}`
      QRCode.toDataURL(url, { width: 56, margin: 1 })
        .then((dataUrl) => {
          roomQrImg.src = dataUrl
          roomQrImg.dataset.qrCode = code
        })
        .catch(() => {})
    }
  }
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
  showToast(ok ? t('room_code_copied') : t('copy_failed'))
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

// Делегирование: переключатель языка
appEl.addEventListener('click', (e) => {
  const btn = (e.target as HTMLElement).closest('.alias-lang-btn') as HTMLButtonElement | null
  if (!btn) return
  const locale = btn.dataset.locale as Locale | undefined
  if (locale === 'ru' || locale === 'uk' || locale === 'en') {
    setLocale(locale)
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

// Easter egg: Konami code ↑↑↓↓←→←→BA
const KONAMI_SEQUENCE = [38, 38, 40, 40, 37, 39, 37, 39, 66, 65]
let konamiIndex = 0
document.addEventListener('keydown', (e) => {
  const code = e.keyCode || e.which
  if (code === KONAMI_SEQUENCE[konamiIndex]) {
    konamiIndex++
    if (konamiIndex === KONAMI_SEQUENCE.length) {
      konamiIndex = 0
      const msg = TAGLINES[Math.floor(Math.random() * TAGLINES.length)]
      showToast(msg)
      playWin()
    }
  } else {
    konamiIndex = 0
  }
})

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

