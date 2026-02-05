import type { GameConfig, GameState, GuessOutcome, Player, PlayerRole, Room, Team, WordEvent } from './models'
import { code } from './code'
import { makeDeck, makeDeckFromWords } from './words'

const DEFAULT_CONFIG: GameConfig = {
  mode: 'to_words',
  round_seconds: 60,
  target_words: 20,
  max_rounds: 10,
  word_pack: 'medium',
  word_pack_lang: 'ru',
  only_cluegiver_can_edit_settings: true,
}

function nowISO(): string {
  return new Date().toISOString()
}

export class AliasState implements DurableObject {
  private state: GameState = { rooms: {}, teams: {}, players: {} }
  private roomCustomWords: Map<string, [string, string[]]> = new Map()
  private connections: Map<string, WebSocket> = new Map()

  constructor(ctx: DurableObjectState, env: Env) {
    void ctx
    void env
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/ws' && request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request)
    }
    if (url.pathname.startsWith('/api/')) {
      return this.handleApi(request, url)
    }
    return new Response('Not Found', { status: 404 })
  }

  private async handleWebSocket(_request: Request): Promise<Response> {
    // WebSocketPair: DO создаёт пару, возвращает client браузеру, server остаётся в DO.
    // Так работает при пересылке запроса через stub.fetch() — request.webSocket не передаётся.
    const pair = new WebSocketPair()
    const [client, server] = Object.values(pair)
    server.accept()

    server.addEventListener('message', (event: MessageEvent) => {
      try {
        const data = JSON.parse(String(event.data))
        if (data.type === 'hello') {
          const playerId = String(data.player_id ?? '')
          if (!this.state.players[playerId]) {
            this.sendError(server, 'unknown_player_id')
            server.close(1008)
            return
          }
          this.connections.set(playerId, server)
          this.sendState(playerId)
          return
        }
        const playerId = this.getPlayerIdForWs(server)
        if (!playerId) return
        this.handleWsAction(playerId, data, server)
      } catch {
        // ignore
      }
    })

    server.addEventListener('close', () => {
      const playerId = this.getPlayerIdForWs(server)
      if (playerId) {
        this.connections.delete(playerId)
        const player = this.state.players[playerId]
        const roomId = player?.room_id
        if (roomId) {
          const stillConnected = [...this.connections.keys()].filter(
            pid => this.state.players[pid]?.room_id === roomId
          )
          if (stillConnected.length === 0) this.roomCustomWords.delete(roomId)
        }
      }
    })

    return new Response(null, { status: 101, webSocket: client })
  }

  private getPlayerIdForWs(ws: WebSocket): string | null {
    for (const [pid, w] of this.connections) {
      if (w === ws) return pid
    }
    return null
  }

  private sendError(ws: WebSocket, message: string): void {
    try {
      ws.send(JSON.stringify({ type: 'error', message }))
    } catch {
      // ignore
    }
  }

  private sendState(playerId: string): void {
    const ws = this.connections.get(playerId)
    if (!ws) return
    try {
      const view = this.viewForPlayer(playerId)
      ws.send(JSON.stringify({ type: 'state', view }))
    } catch {
      // ignore
    }
  }

  private broadcastRoom(roomId: string): void {
    for (const [pid, p] of Object.entries(this.state.players)) {
      if (p.room_id === roomId) this.sendState(pid)
    }
  }

  private broadcastPlayerLeft(roomId: string, playerName: string, excludePlayerId: string): void {
    const msg = JSON.stringify({ type: 'player_left', player_name: playerName })
    for (const [pid, p] of Object.entries(this.state.players)) {
      if (pid !== excludePlayerId && p.room_id === roomId) {
        const conn = this.connections.get(pid)
        if (conn) {
          try {
            conn.send(msg)
          } catch {
            // ignore
          }
        }
      }
    }
  }

  private handleWsAction(playerId: string, msg: Record<string, unknown>, ws: WebSocket): void {
    const player = this.state.players[playerId]
    if (!player) return
    const room = this.state.rooms[player.room_id]
    if (!room) return
    try {
      const type = msg.type as string
      if (type === 'update_settings') {
        const config = msg.config as GameConfig
        this.updateSettings(player.room_id, playerId, config)
      } else if (type === 'start_round') {
        if (!player.team_id) throw new Error('no_team')
        this.startRound(player.team_id, playerId)
      } else if (type === 'end_round') {
        if (!player.team_id) throw new Error('no_team')
        this.endRound(player.team_id)
      } else if (type === 'mark') {
        if (!player.team_id) throw new Error('no_team')
        this.markWord(player.team_id, playerId, (msg.outcome as GuessOutcome))
      } else if (type === 'set_word_outcome') {
        if (!player.team_id) throw new Error('no_team')
        this.setRoundWordOutcome(
          player.team_id,
          playerId,
          msg.round_index as number,
          msg.word_index as number,
          msg.outcome as GuessOutcome
        )
      } else if (type === 'leave_room') {
        const roomId = player.room_id
        const playerName = player.name
        this.broadcastPlayerLeft(roomId, playerName, playerId)
        this.removePlayerFromTeam(playerId)
        delete this.state.players[playerId]
        this.connections.delete(playerId)
        this.broadcastRoom(roomId)
        const stillInRoom = Object.values(this.state.players).some(p => p.room_id === roomId)
        if (!stillInRoom) this.roomCustomWords.delete(roomId)
        try {
          ws.send(JSON.stringify({ type: 'left' }))
        } catch {
          // ignore
        }
        return
      } else {
        this.sendError(ws, 'unknown_message_type')
        return
      }
      this.broadcastRoom(player.room_id)
    } catch (e: unknown) {
      this.sendError(ws, e instanceof Error ? e.message : String(e))
    }
  }

  private async handleApi(request: Request, url: URL): Promise<Response> {
    const path = url.pathname.replace(/^\/api/, '')
    const method = request.method
    const cors = (r: Response) => this.addCors(r, request)

    try {
      if (path === '/rooms' && method === 'POST') {
        const body = await request.json() as { name?: string }
        const name = (body.name ?? 'Комната').toString().trim() || 'Комната'
        const room = this.createRoom(name)
        return cors(json({ room_id: room.id, room_code: room.code }))
      }
      if (path.match(/^\/rooms\/([^/]+)$/) && method === 'GET') {
        const roomCode = path.split('/')[2]
        const room = this.getRoomByCode(roomCode)
        if (!room) return cors(jsonErr('room_not_found', 404))
        return cors(json(this.roomPublicView(room.id)))
      }
      if (path.match(/^\/rooms\/([^/]+)\/teams$/) && method === 'POST') {
        const roomCode = path.split('/')[2]
        const room = this.getRoomByCode(roomCode)
        if (!room) return cors(jsonErr('room_not_found', 404))
        const body = await request.json() as { name?: string }
        const name = (body.name ?? 'Команда').toString().trim() || 'Команда'
        const team = this.createTeam(room.id, name)
        this.broadcastRoom(room.id)
        return cors(json({ team_id: team.id, team_code: team.code }))
      }
      if (path.match(/^\/rooms\/([^/]+)\/join$/) && method === 'POST') {
        const roomCode = path.split('/')[2]
        const room = this.getRoomByCode(roomCode)
        if (!room) return cors(jsonErr('room_not_found', 404))
        const body = await request.json() as { player_name: string; role: PlayerRole; team_code?: string }
        const playerName = (body.player_name ?? '').toString().trim()
        if (!playerName) return cors(jsonErr('Имя не может быть пустым', 400))
        const role = body.role ?? 'guesser'
        let teamId: string | null = null
        if (role !== 'spectator') {
          if (!body.team_code) return cors(jsonErr('team_code_required', 400))
          const team = this.getTeamByCode(room.id, body.team_code)
          if (!team) return cors(jsonErr('team_not_found', 404))
          teamId = team.id
        }
        const player = this.addPlayer(room.id, playerName, role, teamId)
        this.broadcastRoom(room.id)
        return cors(json({ room_id: room.id, player_id: player.id, team_id: player.team_id }))
      }
      const joinTeamMatch = path.match(/^\/rooms\/([^/]+)\/players\/([^/]+)\/team$/)
      if (joinTeamMatch && method === 'POST') {
        const [, roomCode, playerId] = joinTeamMatch
        const room = this.getRoomByCode(roomCode!)
        if (!room) return cors(jsonErr('room_not_found', 404))
        const player = this.state.players[playerId!]
        if (!player || player.room_id !== room.id) return cors(jsonErr('player_not_found', 404))
        const body = await request.json() as { team_code: string; role?: PlayerRole }
        const team = this.getTeamByCode(room.id, body.team_code)
        if (!team) return cors(jsonErr('team_not_found', 404))
        this.joinTeam(playerId!, team.id, body.role ?? 'guesser')
        this.broadcastRoom(room.id)
        const p = this.state.players[playerId!]
        return cors(json({ player_id: p.id, team_id: p.team_id, role: p.role }))
      }
      if (path.match(/^\/rooms\/([^/]+)\/randomize$/) && method === 'POST') {
        const roomCode = path.split('/')[2]
        const room = this.getRoomByCode(roomCode!)
        if (!room) return cors(jsonErr('room_not_found', 404))
        this.randomizeRoom(room.id)
        this.broadcastRoom(room.id)
        return cors(json({ ok: true }))
      }
      const changeRoleMatch = path.match(/^\/rooms\/([^/]+)\/players\/([^/]+)\/role$/)
      if (changeRoleMatch && method === 'POST') {
        const [, roomCode, playerId] = changeRoleMatch
        const room = this.getRoomByCode(roomCode!)
        if (!room) return cors(jsonErr('room_not_found', 404))
        const body = await request.json() as { role: PlayerRole }
        this.setRole(playerId!, body.role)
        this.broadcastRoom(room.id)
        const p = this.state.players[playerId!]
        return cors(json({ player_id: p.id, role: p.role, team_id: p.team_id }))
      }
      if (path.match(/^\/rooms\/([^/]+)\/words$/) && method === 'POST') {
        const roomCode = path.split('/')[2]
        const room = this.getRoomByCode(roomCode!)
        if (!room) return cors(jsonErr('room_not_found', 404))
        const formData = await request.formData()
        const file = formData.get('file') as File | null
        if (!file || !file.name?.toLowerCase().endsWith('.csv')) return cors(jsonErr('csv_file_required', 400))
        if (file.size > 512 * 1024) return cors(jsonErr('file_too_large', 400))
        const text = await file.text()
        const words: string[] = []
        for (const line of text.split(/\r?\n/)) {
          const row = line.split(',')
          const word = (row[0] ?? line).trim()
          if (word) {
            words.push(word)
            if (words.length > 5000) return cors(jsonErr('too_many_words', 400))
          }
        }
        if (words.length === 0) return cors(jsonErr('no_words_in_file', 400))
        const nameWithoutExt = file.name.toLowerCase().endsWith('.csv') ? file.name.slice(0, -4) : file.name
        this.setRoomCustomWords(room.id, nameWithoutExt, words)
        this.broadcastRoom(room.id)
        return cors(json({ ok: true, name: nameWithoutExt }))
      }
      const restartMatch = path.match(/^\/rooms\/([^/]+)\/players\/([^/]+)\/restart$/)
      if (restartMatch && method === 'POST') {
        const [, roomCode, playerId] = restartMatch
        const room = this.getRoomByCode(roomCode!)
        if (!room) return cors(jsonErr('room_not_found', 404))
        this.restartRoom(room.id, playerId!)
        this.broadcastRoom(room.id)
        const view = this.viewForPlayer(playerId!)
        return cors(json({ ok: true, view }))
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e)
      const status = msg.includes('not_found') ? 404 : msg.includes('Permission') ? 403 : 400
      return cors(jsonErr(msg, status))
    }
    return cors(new Response('Not Found', { status: 404 }))
  }

  private addCors(res: Response, req: Request): Response {
    const origin = req.headers.get('Origin') || '*'
    const headers = new Headers(res.headers)
    headers.set('Access-Control-Allow-Origin', origin)
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    headers.set('Access-Control-Allow-Headers', 'Content-Type')
    headers.set('Access-Control-Max-Age', '86400')
    return new Response(res.body, { status: res.status, headers })
  }

  private createRoom(name: string): Room {
    const id = crypto.randomUUID()
    const room: Room = {
      id,
      code: code(6),
      name: name || 'Комната',
      team_ids: [],
      config: { ...DEFAULT_CONFIG },
      game_over: false,
      winner_team_id: null,
    }
    this.state.rooms[id] = room
    return room
  }

  private getRoomByCode(roomCode: string): Room | null {
    const upper = roomCode.toUpperCase()
    for (const r of Object.values(this.state.rooms)) {
      if (r.code.toUpperCase() === upper) return r
    }
    return null
  }

  private ensureCanChangeWordPack(roomId: string): void {
    const room = this.state.rooms[roomId]
    if (room.game_over) return
    for (const tid of room.team_ids) {
      const t = this.state.teams[tid]
      if (t?.round_number > 0) throw new Error('cannot_change_word_pack_after_game_started')
    }
  }

  private replaceRoomDecks(roomId: string): void {
    const room = this.state.rooms[roomId]
    const custom = this.roomCustomWords.get(roomId)
    const pack = room.config.word_pack ?? 'medium'
    const packLang = room.config.word_pack_lang ?? 'ru'
    for (const tid of room.team_ids) {
      const t = this.state.teams[tid]
      if (!t) continue
      if (custom) {
        const [, words] = custom
        t.deck = makeDeckFromWords(words, String(t.id), 600)
      } else {
        t.deck = makeDeck(String(t.id), 600, pack, packLang)
      }
    }
  }

  private setRoomCustomWords(roomId: string, nameWithoutExt: string, words: string[]): void {
    this.ensureCanChangeWordPack(roomId)
    this.roomCustomWords.set(roomId, [nameWithoutExt, words])
    this.replaceRoomDecks(roomId)
  }

  private createTeam(roomId: string, name: string): Team {
    const room = this.state.rooms[roomId]
    const id = crypto.randomUUID()
    const custom = this.roomCustomWords.get(roomId)
    const pack = room.config.word_pack ?? 'medium'
    const packLang = room.config.word_pack_lang ?? 'ru'
    const deck = custom
      ? makeDeckFromWords(custom[1], id, 600)
      : makeDeck(id, 600, pack, packLang)
    const team: Team = {
      id,
      room_id: roomId,
      name: name || 'Команда',
      code: code(4),
      player_ids: [],
      cluegiver_id: null,
      deck,
      current_index: 0,
      last_revealed_word: null,
      score: 0,
      total_correct: 0,
      round_number: 0,
      round_active: false,
      round_started_at: null,
      round_ends_at: null,
      rounds: [],
    }
    this.state.teams[id] = team
    room.team_ids.push(id)
    return team
  }

  private getTeamByCode(roomId: string, teamCode: string): Team | null {
    const room = this.state.rooms[roomId]
    const upper = teamCode.toUpperCase()
    for (const tid of room.team_ids) {
      const t = this.state.teams[tid]
      if (t?.code.toUpperCase() === upper) return t
    }
    return null
  }

  private addPlayer(roomId: string, name: string, role: PlayerRole, teamId: string | null): Player {
    const id = crypto.randomUUID()
    const player: Player = {
      id,
      name: name || 'Игрок',
      room_id: roomId,
      role,
      team_id: teamId,
    }
    this.state.players[id] = player
    if (teamId) {
      const team = this.state.teams[teamId]
      team.player_ids.push(id)
      if (role === 'cluegiver' && !team.cluegiver_id) team.cluegiver_id = id
    }
    return player
  }

  private removePlayerFromTeam(playerId: string): void {
    const player = this.state.players[playerId]
    if (!player.team_id) return
    const team = this.state.teams[player.team_id]
    if (team) {
      team.player_ids = team.player_ids.filter(p => p !== playerId)
      if (team.cluegiver_id === playerId) team.cluegiver_id = null
    }
    player.team_id = null
  }

  private joinTeam(playerId: string, teamId: string, role: PlayerRole = 'guesser'): void {
    if (role === 'spectator') throw new Error('invalid_role')
    const player = this.state.players[playerId]
    const team = this.state.teams[teamId]
    const room = this.state.rooms[player.room_id]
    if (player.room_id !== team.room_id) throw new Error('wrong_room')
    // Первый игрок в пустой команде автоматически становится загадывающим
    if (team.player_ids.length === 0) role = 'cluegiver'
    if (role !== 'guesser' && !room.game_over) {
      for (const tid of room.team_ids) {
        if (this.state.teams[tid]?.round_number > 0) throw new Error('cannot_change_role_during_game')
      }
    }
    this.removePlayerFromTeam(playerId)
    player.team_id = teamId
    player.role = role
    team.player_ids.push(playerId)
    if (role === 'cluegiver') {
      if (team.cluegiver_id && team.cluegiver_id !== playerId) {
        const old = this.state.players[team.cluegiver_id]
        if (old) old.role = 'guesser'
      }
      team.cluegiver_id = playerId
    } else if (team.cluegiver_id === playerId) {
      team.cluegiver_id = null
    }
  }

  private setRole(playerId: string, role: PlayerRole): void {
    const player = this.state.players[playerId]
    const room = this.state.rooms[player.room_id]
    if (!room.game_over) {
      for (const tid of room.team_ids) {
        if (this.state.teams[tid]?.round_number > 0) throw new Error('cannot_change_role_during_game')
      }
    }
    if (role === 'spectator') {
      this.removePlayerFromTeam(playerId)
      player.role = 'spectator'
      return
    }
    if (!player.team_id) throw new Error('no_team')
    const team = this.state.teams[player.team_id]
    if (role === 'cluegiver') {
      if (team.cluegiver_id && team.cluegiver_id !== playerId) {
        const old = this.state.players[team.cluegiver_id]
        if (old) old.role = 'guesser'
      }
      team.cluegiver_id = playerId
    } else if (team.cluegiver_id === playerId) {
      team.cluegiver_id = null
    }
    player.role = role
  }

  private randomizeRoom(roomId: string): void {
    const room = this.state.rooms[roomId]
    if (!room.team_ids.length) throw new Error('no_teams')
    if (!room.game_over) {
      for (const tid of room.team_ids) {
        if (this.state.teams[tid]?.round_number > 0) throw new Error('cannot_randomize_during_game')
      }
    }
    for (const tid of room.team_ids) {
      const t = this.state.teams[tid]
      if (t?.round_active) throw new Error('cannot_randomize_during_round')
    }
    const playerIds = Object.entries(this.state.players)
      .filter(([, p]) => p.room_id === roomId)
      .map(([id]) => id)
    if (!playerIds.length) return
    for (const tid of room.team_ids) {
      const t = this.state.teams[tid]
      t!.player_ids = []
      t!.cluegiver_id = null
    }
    shuffle(playerIds)
    const teamIds = [...room.team_ids]
    // Round-robin: when player count is divisible by team count, all teams get equal size; otherwise some get one more.
    for (let i = 0; i < playerIds.length; i++) {
      const pid = playerIds[i]
      const tid = teamIds[i % teamIds.length]
      const p = this.state.players[pid]
      p.team_id = tid
      p.role = 'guesser'
      this.state.teams[tid].player_ids.push(pid)
    }
    const nPlayers = playerIds.length
    const nTeams = teamIds.length
    if (nTeams && nPlayers % nTeams === 0) {
      const expected = nPlayers / nTeams
      for (const tid of teamIds) {
        if (this.state.teams[tid].player_ids.length !== expected) {
          throw new Error('equal_teams_when_divisible')
        }
      }
    }
    for (const tid of teamIds) {
      const t = this.state.teams[tid]
      if (t.player_ids.length) {
        const cg = t.player_ids[Math.floor(Math.random() * t.player_ids.length)]
        t.cluegiver_id = cg
        this.state.players[cg].role = 'cluegiver'
      }
    }
  }

  private ensureCanEditRoom(roomId: string, actorPlayerId: string): void {
    const actor = this.state.players[actorPlayerId]
    const room = this.state.rooms[roomId]
    if (room.game_over) throw new Error('game_over')
    if (!actor.team_id) throw new Error('only_cluegiver')
    for (const tid of room.team_ids) {
      if (this.state.teams[tid]?.round_active) throw new Error('cannot_change_settings_during_round')
    }
    const onlyCluegiver = room.config.only_cluegiver_can_edit_settings !== false
    if (onlyCluegiver && actor.role !== 'cluegiver') throw new Error('only_cluegiver')
  }

  private ensureCanChangeWinCondition(roomId: string): void {
    const room = this.state.rooms[roomId]
    if (room.game_over) return
    for (const tid of room.team_ids) {
      const t = this.state.teams[tid]
      if (t?.round_number > 0) throw new Error('cannot_change_win_condition_after_game_started')
    }
  }

  private updateSettings(roomId: string, actorPlayerId: string, config: GameConfig): void {
    this.ensureCanEditRoom(roomId, actorPlayerId)
    const room = this.state.rooms[roomId]
    room.config.round_seconds = Math.max(10, Math.min(Number(config.round_seconds) || 60, 600))
    room.config.target_words = Math.max(1, Math.min(Number(config.target_words) || 20, 500))
    room.config.max_rounds = Math.max(1, Math.min(Number(config.max_rounds) || 10, 100))
    if (config.mode != null && config.mode !== room.config.mode) {
      this.ensureCanChangeWinCondition(roomId)
    }
    room.config.mode = config.mode ?? room.config.mode
    if (config.word_pack != null) {
      this.ensureCanChangeWordPack(roomId)
      room.config.word_pack = config.word_pack
      if (!this.roomCustomWords.has(roomId)) this.replaceRoomDecks(roomId)
    }
    if (config.word_pack_lang != null) {
      this.ensureCanChangeWordPack(roomId)
      room.config.word_pack_lang = config.word_pack_lang
      if (!this.roomCustomWords.has(roomId)) this.replaceRoomDecks(roomId)
    }
    if (config.only_cluegiver_can_edit_settings !== undefined) {
      room.config.only_cluegiver_can_edit_settings = config.only_cluegiver_can_edit_settings
    }
  }

  private roomOfTeam(teamId: string): Room {
    return this.state.rooms[this.state.teams[teamId].room_id]
  }

  private startRound(teamId: string, actorPlayerId: string): void {
    const team = this.state.teams[teamId]
    const room = this.roomOfTeam(teamId)
    if (room.game_over) throw new Error('game_over')
    if (team.cluegiver_id !== actorPlayerId) throw new Error('only_cluegiver')
    if (team.round_active) throw new Error('round_already_active')
    if (room.config.mode === 'to_rounds' && team.round_number >= room.config.max_rounds) {
      throw new Error('max_rounds_reached_for_team')
    }
    // Не начинать раунд, пока у другой команды раунд уже идёт
    const teamIds = room.team_ids
    if (!Array.isArray(teamIds) || teamIds.length === 0) throw new Error('no_teams')
    for (const tid of teamIds) {
      if (tid !== teamId && this.state.teams[tid]?.round_active) throw new Error('another_team_round_active')
    }
    // Очерёдность: раунд 1 — команда 0, раунд 2 — команда 1, раунд 3 — команда 0, ...
    const totalRounds = teamIds.reduce((sum, tid) => sum + (this.state.teams[tid]?.round_number ?? 0), 0)
    const nextIndex = totalRounds % teamIds.length
    const teamThatCanStartId = teamIds[nextIndex]
    if (String(teamId) !== String(teamThatCanStartId)) throw new Error('not_your_turn')
    team.round_number += 1
    team.round_active = true
    team.round_started_at = nowISO()
    const end = new Date(Date.now() + room.config.round_seconds * 1000)
    team.round_ends_at = end.toISOString()
    team.rounds.push([])
  }

  private rotateCluegiver(teamId: string): void {
    const team = this.state.teams[teamId]
    if (!team.player_ids.length || !team.cluegiver_id) return
    const idx = team.player_ids.indexOf(team.cluegiver_id)
    if (idx < 0) return
    const nextIdx = (idx + 1) % team.player_ids.length
    const nextId = team.player_ids[nextIdx]
    if (nextId === team.cluegiver_id) return
    const old = this.state.players[team.cluegiver_id]
    if (old) old.role = 'guesser'
    team.cluegiver_id = nextId
    const next = this.state.players[nextId]
    if (next) next.role = 'cluegiver'
  }

  private maybeFinishRoom(room: Room): void {
    if (room.game_over) return
    if (room.config.mode !== 'to_rounds') return
    for (const tid of room.team_ids) {
      const t = this.state.teams[tid]
      if (t?.round_active) return
      if (t && t.round_number < room.config.max_rounds) return
    }
    room.game_over = true
    let best: Team | null = null
    for (const tid of room.team_ids) {
      const t = this.state.teams[tid]
      if (!best || t.score > best.score) best = t
    }
    room.winner_team_id = best?.id ?? null
  }

  private endRound(teamId: string): void {
    const team = this.state.teams[teamId]
    if (!team.round_active) return
    team.round_active = false
    team.round_started_at = null
    team.round_ends_at = null
    this.rotateCluegiver(teamId)
    this.maybeFinishRoom(this.roomOfTeam(teamId))
  }

  private applyScoring(team: Team, outcome: GuessOutcome): void {
    if (outcome === 'correct') {
      team.score += 1
      team.total_correct += 1
    } else if (outcome === 'skip') {
      team.score -= 1
    }
  }

  private currentWord(teamId: string): string | null {
    const team = this.state.teams[teamId]
    if (!team.deck.length) return null
    const idx = Math.min(team.current_index, team.deck.length - 1)
    return team.deck[Math.max(0, idx)] ?? null
  }

  private markWord(teamId: string, actorPlayerId: string, outcome: GuessOutcome): void {
    const team = this.state.teams[teamId]
    const room = this.roomOfTeam(teamId)
    if (room.game_over) throw new Error('game_over')
    if (team.cluegiver_id !== actorPlayerId) throw new Error('only_cluegiver')
    if (!team.round_active) throw new Error('round_not_active')
    const word = this.currentWord(teamId)
    if (!word) throw new Error('no_word')
    const ev: WordEvent = { word, outcome, at: nowISO() }
    if (!team.rounds.length) team.rounds.push([])
    team.rounds[team.rounds.length - 1].push(ev)
    team.last_revealed_word = word
    this.applyScoring(team, outcome)
    if (room.config.mode === 'to_words' && team.total_correct >= room.config.target_words) {
      room.game_over = true
      room.winner_team_id = team.id
      this.endRound(teamId)
    }
    team.current_index = Math.min(team.current_index + 1, Math.max(0, team.deck.length - 1))
    if (team.round_ends_at && new Date() > new Date(team.round_ends_at)) this.endRound(teamId)
    this.maybeFinishRoom(room)
  }

  private recalculateTeamScore(teamId: string): void {
    const team = this.state.teams[teamId]
    let score = 0
    let totalCorrect = 0
    for (const round of team.rounds) {
      for (const ev of round) {
        if (ev.outcome === 'correct') {
          score += 1
          totalCorrect += 1
        } else if (ev.outcome === 'skip') score -= 1
      }
    }
    team.score = score
    team.total_correct = totalCorrect
  }

  private setRoundWordOutcome(
    teamId: string,
    actorPlayerId: string,
    roundIdx: number,
    wordIdx: number,
    outcome: GuessOutcome
  ): void {
    const team = this.state.teams[teamId]
    const room = this.roomOfTeam(teamId)
    if (room.game_over) throw new Error('game_over')
    if (!team.player_ids.includes(actorPlayerId)) throw new Error('not_in_team')
    if (team.round_active) throw new Error('round_active')
    if (roundIdx < 0 || roundIdx >= team.rounds.length) throw new Error('invalid_round')
    const round = team.rounds[roundIdx]
    if (wordIdx < 0 || wordIdx >= round.length) throw new Error('invalid_word')
    round[wordIdx] = { ...round[wordIdx], outcome, at: round[wordIdx].at }
    this.recalculateTeamScore(teamId)
    if (room.config.mode === 'to_words' && team.total_correct >= room.config.target_words) {
      room.game_over = true
      room.winner_team_id = team.id
    }
    this.maybeFinishRoom(room)
  }

  private restartRoom(roomId: string, actorPlayerId: string): void {
    const room = this.state.rooms[roomId]
    const actor = this.state.players[actorPlayerId]
    if (!actor || actor.room_id !== roomId) throw new Error('wrong_room')
    if (actor.role !== 'cluegiver' || !actor.team_id) throw new Error('only_cluegiver')
    room.game_over = false
    room.winner_team_id = null
    // все игроки переходят в «Игроки без команды»
    for (const p of Object.values(this.state.players)) {
      if (p.room_id !== roomId) continue
      this.removePlayerFromTeam(p.id)
      p.role = 'spectator'
    }
    for (const tid of room.team_ids) {
      const t = this.state.teams[tid]
      if (!t) continue
      t.player_ids = []
      t.cluegiver_id = null
      t.score = 0
      t.total_correct = 0
      t.round_number = 0
      t.round_active = false
      t.round_started_at = null
      t.round_ends_at = null
      t.rounds = []
      t.last_revealed_word = null
      t.current_index = 0
    }
  }

  private roomPublicView(roomId: string): Record<string, unknown> {
    const room = this.state.rooms[roomId]
    const teams = room.team_ids.map(tid => {
      const t = this.state.teams[tid]
      const cluegiverName = t.cluegiver_id ? this.state.players[t.cluegiver_id]?.name : null
      const playerNames = t.player_ids.map(pid => this.state.players[pid]?.name).filter((n): n is string => !!n)
      return {
        id: t.id,
        name: t.name,
        code: t.code,
        score: t.score,
        total_correct: t.total_correct,
        round_number: t.round_number,
        round_active: t.round_active,
        players_count: t.player_ids.length,
        cluegiver_name: cluegiverName,
        player_names: playerNames,
      }
    })
    const spectators = Object.values(this.state.players)
      .filter(p => p.room_id === roomId && p.role === 'spectator')
      .map(p => p.name)
    const customName = this.roomCustomWords.get(roomId)?.[0] ?? null
    return {
      id: room.id,
      code: room.code,
      name: room.name,
      config: room.config,
      game_over: room.game_over,
      winner_team_id: room.winner_team_id,
      teams,
      spectators,
      custom_words_name: customName,
    }
  }

  private teamPrivateView(teamId: string): Record<string, unknown> {
    const team = this.state.teams[teamId]
    const players = team.player_ids
      .filter(pid => this.state.players[pid])
      .map(pid => this.state.players[pid])
    return {
      id: team.id,
      name: team.name,
      code: team.code,
      players,
      cluegiver_id: team.cluegiver_id,
      score: team.score,
      total_correct: team.total_correct,
      round_number: team.round_number,
      round_active: team.round_active,
      round_started_at: team.round_started_at,
      round_ends_at: team.round_ends_at,
      rounds: team.rounds,
      last_revealed_word: team.last_revealed_word,
    }
  }

  private viewForPlayer(playerId: string): Record<string, unknown> {
    const player = this.state.players[playerId]
    if (!player) throw new Error('player_not_found')
    const room = this.state.rooms[player.room_id]
    const roomView = this.roomPublicView(player.room_id)
    const me = { id: player.id, name: player.name, role: player.role, team_id: player.team_id }
    let myTeam: Record<string, unknown> | null = null
    let spectatorTeams: Record<string, unknown>[] | null = null
    if (player.team_id) {
      myTeam = this.teamPrivateView(player.team_id) as Record<string, unknown>
      const team = this.state.teams[player.team_id]
      if (team.cluegiver_id === player.id && player.role === 'cluegiver') {
        (myTeam as Record<string, unknown>).current_word = this.currentWord(player.team_id)
      }
    } else if (player.role === 'spectator') {
      spectatorTeams = room.team_ids.map(tid => this.teamPrivateView(tid))
    }
    const activeTeamId = room.team_ids.find(tid => this.state.teams[tid]?.round_active)
    let activeTeam: { id: string; name: string; rounds: WordEvent[][]; round_ends_at: string | null } | null = null
    if (activeTeamId) {
      const t = this.state.teams[activeTeamId]
      activeTeam = { id: t.id, name: t.name, rounds: t.rounds, round_ends_at: t.round_ends_at }
    }
    // Чья очередь начинать следующий раунд (для блокировки кнопки на фронте)
    const teamIds = room.team_ids
    const totalRounds = Array.isArray(teamIds) && teamIds.length > 0
      ? teamIds.reduce((sum, tid) => sum + (this.state.teams[tid]?.round_number ?? 0), 0)
      : 0
    const nextTurnIndex = Array.isArray(teamIds) && teamIds.length > 0 ? totalRounds % teamIds.length : 0
    const canStartRoundTeamId = Array.isArray(teamIds) && teamIds.length > 0 ? teamIds[nextTurnIndex] : null
    return {
      room: roomView,
      me,
      my_team: myTeam,
      spectator_teams: spectatorTeams,
      active_team: activeTeam,
      can_start_round_team_id: canStartRoundTeamId,
    }
  }
}

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    headers: { 'Content-Type': 'application/json' },
  })
}

function jsonErr(detail: string, status: number): Response {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function shuffle<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]]
  }
}

export interface Env {
  ALIAS_STATE: DurableObjectNamespace
}
