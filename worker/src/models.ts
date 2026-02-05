/** Типы и интерфейсы, совместимые с FastAPI-бэкендом. */

export type PlayerRole = 'cluegiver' | 'guesser' | 'spectator'
export type GameMode = 'to_words' | 'to_rounds'
export type WordPack = 'simple' | 'medium' | 'hard'
export type WordPackLang = 'ru' | 'uk' | 'en'
export type GuessOutcome = 'correct' | 'dont_know' | 'skip'

export interface GameConfig {
  mode: GameMode
  round_seconds: number
  target_words: number
  max_rounds: number
  word_pack?: WordPack
  word_pack_lang?: WordPackLang
  /** true = только загадывающий может менять настройки; false = любой игрок в команде */
  only_cluegiver_can_edit_settings?: boolean
}

export interface WordEvent {
  word: string
  outcome: GuessOutcome
  at: string // ISO datetime
}

export interface Room {
  id: string
  code: string
  name: string
  team_ids: string[]
  config: GameConfig
  game_over: boolean
  winner_team_id: string | null
}

export interface Player {
  id: string
  name: string
  room_id: string
  role: PlayerRole
  team_id: string | null
}

export interface Team {
  id: string
  room_id: string
  name: string
  code: string
  player_ids: string[]
  cluegiver_id: string | null
  deck: string[]
  current_index: number
  last_revealed_word: string | null
  score: number
  total_correct: number
  round_number: number
  round_active: boolean
  round_started_at: string | null // ISO
  round_ends_at: string | null
  rounds: WordEvent[][]
}

export interface GameState {
  rooms: Record<string, Room>
  teams: Record<string, Team>
  players: Record<string, Player>
}

export interface RoomTeamSummary {
  id: string
  name: string
  code: string
  score: number
  total_correct: number
  round_number: number
  round_active: boolean
  players_count: number
  cluegiver_name?: string | null
}

export interface RoomPublicView {
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

export interface TeamPrivateView {
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

export interface PlayerView {
  id: string
  name: string
  role: PlayerRole
  team_id: string | null
}

export interface WsStateView {
  room: RoomPublicView
  me: PlayerView
  my_team: TeamPrivateView | null
  spectator_teams?: TeamPrivateView[] | null
}
