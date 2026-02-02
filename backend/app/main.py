from __future__ import annotations

from typing import Dict, Optional
from uuid import UUID

import csv
import io

from fastapi import FastAPI, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator

from .models import (
    GameConfig,
    GuessOutcome,
    PlayerRole,
    WsActionEndRound,
    WsActionMark,
    WsActionSetWordOutcome,
    WsActionStartRound,
    WsActionUpdateSettings,
    WsClientHello,
    WsServerError,
    WsServerState,
)
from .state import StateStore


app = FastAPI(title="Alias Web")
store = StateStore()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


NAME_MIN_LEN = 1
NAME_MAX_LEN = 64
ROOM_CODE_MIN_LEN = 4
ROOM_CODE_MAX_LEN = 10
TEAM_CODE_LEN = 4


class CreateRoomRequest(BaseModel):
    name: str = Field(default="Комната", min_length=NAME_MIN_LEN, max_length=NAME_MAX_LEN)

    @field_validator("name", mode="before")
    @classmethod
    def strip_room_name(cls, v: str) -> str:
        if isinstance(v, str):
            v = v.strip() or "Комната"
        return v


class CreateRoomResponse(BaseModel):
    room_id: UUID
    room_code: str


class CreateTeamRequest(BaseModel):
    name: str = Field(min_length=NAME_MIN_LEN, max_length=NAME_MAX_LEN)

    @field_validator("name", mode="before")
    @classmethod
    def strip_team_name(cls, v: str) -> str:
        if isinstance(v, str):
            v = v.strip() or "Команда"
        return v


class CreateTeamResponse(BaseModel):
    team_id: UUID
    team_code: str


class JoinRoomRequest(BaseModel):
    player_name: str = Field(min_length=NAME_MIN_LEN, max_length=NAME_MAX_LEN)
    role: PlayerRole
    team_code: Optional[str] = None

    @field_validator("player_name", mode="before")
    @classmethod
    def strip_player_name(cls, v: str) -> str:
        if isinstance(v, str):
            v = v.strip()
            if not v:
                raise ValueError("Имя не может быть пустым")
        return v


class JoinRoomResponse(BaseModel):
    room_id: UUID
    player_id: UUID
    team_id: Optional[UUID] = None


class JoinTeamRequest(BaseModel):
    team_code: str = Field(min_length=1, max_length=16)
    role: PlayerRole = PlayerRole.guesser


class JoinTeamResponse(BaseModel):
    player_id: UUID
    team_id: UUID
    role: PlayerRole


class RandomizeResponse(BaseModel):
    ok: bool = True


class ChangeRoleRequest(BaseModel):
    role: PlayerRole


class ChangeRoleResponse(BaseModel):
    player_id: UUID
    role: PlayerRole
    team_id: Optional[UUID] = None


class RestartGameResponse(BaseModel):
    ok: bool = True


class UploadWordsResponse(BaseModel):
    ok: bool = True
    name: str  # filename without .csv


class Connections:
    def __init__(self) -> None:
        self._by_player: Dict[UUID, WebSocket] = {}

    async def connect(self, player_id: UUID, ws: WebSocket) -> None:
        self._by_player[player_id] = ws

    def disconnect(self, player_id: UUID) -> None:
        self._by_player.pop(player_id, None)

    async def send_state(self, player_id: UUID) -> None:
        ws = self._by_player.get(player_id)
        if not ws:
            return
        view = store.view_for_player(player_id)
        await ws.send_json(WsServerState(view=view).model_dump())

    async def broadcast_room(self, room_id: UUID) -> None:
        # отправляем каждому игроку персональный view (cluegiver/team/spectator)
        for pid, player in list(store.state.players.items()):
            if player.room_id == room_id and pid in self._by_player:
                await self.send_state(pid)

    async def broadcast_player_left(self, room_id: UUID, player_name: str, exclude_player_id: Optional[UUID] = None) -> None:
        msg = {"type": "player_left", "player_name": player_name}
        for pid, player in list(store.state.players.items()):
            if pid != exclude_player_id and player.room_id == room_id and pid in self._by_player:
                ws = self._by_player[pid]
                await ws.send_json(msg)

    async def send_error(self, ws: WebSocket, message: str) -> None:
        await ws.send_json(WsServerError(message=message).model_dump())


connections = Connections()


@app.post("/api/rooms", response_model=CreateRoomResponse)
def create_room(req: CreateRoomRequest) -> CreateRoomResponse:
    room = store.create_room(req.name)
    return CreateRoomResponse(room_id=room.id, room_code=room.code)


@app.get("/api/rooms/{room_code}")
def get_room(room_code: str) -> dict:
    room = store.get_room_by_code(room_code)
    if not room:
        raise HTTPException(status_code=404, detail="room_not_found")
    return store.room_public_view(room.id).model_dump(mode="json")


@app.post("/api/rooms/{room_code}/teams", response_model=CreateTeamResponse)
async def create_team(room_code: str, req: CreateTeamRequest) -> CreateTeamResponse:
    room = store.get_room_by_code(room_code)
    if not room:
        raise HTTPException(status_code=404, detail="room_not_found")
    team = store.create_team(room.id, req.name)
    await connections.broadcast_room(room.id)
    return CreateTeamResponse(team_id=team.id, team_code=team.code)


@app.post("/api/rooms/{room_code}/join", response_model=JoinRoomResponse)
async def join_room(room_code: str, req: JoinRoomRequest) -> JoinRoomResponse:
    room = store.get_room_by_code(room_code)
    if not room:
        raise HTTPException(status_code=404, detail="room_not_found")

    team_id: Optional[UUID] = None
    if req.role != PlayerRole.spectator:
        if not req.team_code:
            raise HTTPException(status_code=400, detail="team_code_required")
        team = store.get_team_by_code(room.id, req.team_code)
        if not team:
            raise HTTPException(status_code=404, detail="team_not_found")
        team_id = team.id

    player = store.add_player(room_id=room.id, name=req.player_name, role=req.role, team_id=team_id)
    await connections.broadcast_room(room.id)
    return JoinRoomResponse(room_id=room.id, player_id=player.id, team_id=team_id)


@app.post("/api/rooms/{room_code}/players/{player_id}/team", response_model=JoinTeamResponse)
async def join_team(room_code: str, player_id: UUID, req: JoinTeamRequest) -> JoinTeamResponse:
    room = store.get_room_by_code(room_code)
    if not room:
        raise HTTPException(status_code=404, detail="room_not_found")

    player = store.state.players.get(player_id)
    if not player:
        raise HTTPException(status_code=404, detail="player_not_found")
    if player.room_id != room.id:
        raise HTTPException(status_code=403, detail="wrong_room")

    team = store.get_team_by_code(room.id, req.team_code)
    if not team:
        raise HTTPException(status_code=404, detail="team_not_found")

    try:
        store.join_team(player_id=player_id, team_id=team.id, role=req.role)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    await connections.broadcast_room(room.id)
    return JoinTeamResponse(player_id=player_id, team_id=team.id, role=store.state.players[player_id].role)


@app.post("/api/rooms/{room_code}/randomize", response_model=RandomizeResponse)
async def randomize_room(room_code: str) -> RandomizeResponse:
    room = store.get_room_by_code(room_code)
    if not room:
        raise HTTPException(status_code=404, detail="room_not_found")
    try:
        store.randomize_room(room.id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    await connections.broadcast_room(room.id)
    return RandomizeResponse(ok=True)


@app.post("/api/rooms/{room_code}/players/{player_id}/role", response_model=ChangeRoleResponse)
async def change_role(room_code: str, player_id: UUID, req: ChangeRoleRequest) -> ChangeRoleResponse:
    room = store.get_room_by_code(room_code)
    if not room:
        raise HTTPException(status_code=404, detail="room_not_found")

    player = store.state.players.get(player_id)
    if not player:
        raise HTTPException(status_code=404, detail="player_not_found")
    if player.room_id != room.id:
        raise HTTPException(status_code=403, detail="wrong_room")

    # в UI это используется только для игроков в команде (guesser/cluegiver),
    # spectator оставляем как отдельный кейс (выйти из команды).
    try:
        store.set_role(player_id=player_id, role=req.role)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    await connections.broadcast_room(room.id)
    p = store.state.players[player_id]
    return ChangeRoleResponse(player_id=player_id, role=p.role, team_id=p.team_id)


UPLOAD_MAX_BYTES = 512 * 1024  # 512 KB
UPLOAD_MAX_WORDS = 5000


@app.post("/api/rooms/{room_code}/words", response_model=UploadWordsResponse)
async def upload_room_words(room_code: str, file: UploadFile = File(...)) -> UploadWordsResponse:
    room = store.get_room_by_code(room_code)
    if not room:
        raise HTTPException(status_code=404, detail="room_not_found")
    if not file.filename or not file.filename.lower().endswith(".csv"):
        raise HTTPException(status_code=400, detail="csv_file_required")
    try:
        raw = await file.read(UPLOAD_MAX_BYTES + 1)
    except Exception:
        raise HTTPException(status_code=400, detail="file_read_error")
    if len(raw) > UPLOAD_MAX_BYTES:
        raise HTTPException(status_code=400, detail="file_too_large")
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="utf8_required")
    words: list[str] = []
    for line in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = line.strip()
        if not line:
            continue
        row = next(csv.reader(io.StringIO(line)), [line])
        word = (row[0] or line).strip()
        if word:
            words.append(word)
            if len(words) > UPLOAD_MAX_WORDS:
                raise HTTPException(status_code=400, detail="too_many_words")
    if not words:
        raise HTTPException(status_code=400, detail="no_words_in_file")
    name_without_ext = file.filename[:-4] if file.filename.lower().endswith(".csv") else file.filename
    try:
        store.set_room_custom_words(room.id, name_without_ext, words)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e
    await connections.broadcast_room(room.id)
    return UploadWordsResponse(ok=True, name=name_without_ext)


@app.post("/api/rooms/{room_code}/players/{player_id}/restart", response_model=RestartGameResponse)
async def restart_game(room_code: str, player_id: UUID) -> RestartGameResponse:
    room = store.get_room_by_code(room_code)
    if not room:
        raise HTTPException(status_code=404, detail="room_not_found")

    player = store.state.players.get(player_id)
    if not player:
        raise HTTPException(status_code=404, detail="player_not_found")
    if player.room_id != room.id:
        raise HTTPException(status_code=403, detail="wrong_room")

    try:
        store.restart_room(room.id, player_id)
    except PermissionError as e:
        raise HTTPException(status_code=403, detail=str(e)) from e

    await connections.broadcast_room(room.id)
    return RestartGameResponse(ok=True)


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket) -> None:
    player_id: UUID | None = None
    try:
        # Важно: сначала принимаем handshake, потом читаем сообщения клиента.
        await ws.accept()

        raw = await ws.receive_json()
        hello = WsClientHello.model_validate(raw)
        player_id = hello.player_id

        if player_id not in store.state.players:
            await connections.send_error(ws, "unknown_player_id")
            await ws.close(code=1008)
            return

        await connections.connect(player_id, ws)
        await connections.send_state(player_id)

        while True:
            msg = await ws.receive_json()
            msg_type = msg.get("type")
            try:
                if msg_type == "next_word":
                    # legacy ignored in multi-team version
                    await connections.send_error(ws, "deprecated")
                elif msg_type == "update_settings":
                    action = WsActionUpdateSettings.model_validate(msg)
                    player = store.state.players[player_id]
                    store.update_settings(room_id=player.room_id, actor_player_id=player_id, config=action.config)
                    await connections.broadcast_room(player.room_id)
                elif msg_type == "start_round":
                    _ = WsActionStartRound.model_validate(msg)
                    player = store.state.players[player_id]
                    if not player.team_id:
                        raise PermissionError("no_team")
                    store.start_round(team_id=player.team_id, actor_player_id=player_id)
                    await connections.broadcast_room(player.room_id)
                elif msg_type == "end_round":
                    _ = WsActionEndRound.model_validate(msg)
                    player = store.state.players[player_id]
                    if not player.team_id:
                        raise PermissionError("no_team")
                    store.end_round(team_id=player.team_id)
                    await connections.broadcast_room(player.room_id)
                elif msg_type == "mark":
                    action = WsActionMark.model_validate(msg)
                    player = store.state.players[player_id]
                    if not player.team_id:
                        raise PermissionError("no_team")
                    store.mark_word(team_id=player.team_id, actor_player_id=player_id, outcome=action.outcome)
                    await connections.broadcast_room(player.room_id)
                elif msg_type == "set_word_outcome":
                    action = WsActionSetWordOutcome.model_validate(msg)
                    player = store.state.players[player_id]
                    if not player.team_id:
                        raise PermissionError("no_team")
                    store.set_round_word_outcome(
                        team_id=player.team_id,
                        actor_player_id=player_id,
                        round_index=action.round_index,
                        word_index=action.word_index,
                        outcome=action.outcome,
                    )
                    await connections.broadcast_room(player.room_id)
                else:
                    await connections.send_error(ws, "unknown_message_type")
            except Exception as e:  # noqa: BLE001
                await connections.send_error(ws, str(e))

    except WebSocketDisconnect:
        pass
    finally:
        if player_id is not None:
            player = store.state.players.get(player_id)
            room_id = player.room_id if player else None
            player_name = player.name if player else None
            if room_id is not None and player_name is not None:
                await connections.broadcast_player_left(room_id, player_name, exclude_player_id=player_id)
            removed = store.remove_player(player_id)
            connections.disconnect(player_id)
            if removed is not None:
                r_id, _ = removed
                await connections.broadcast_room(r_id)
            if room_id is not None:
                still_connected = [
                    pid for pid, p in store.state.players.items()
                    if p.room_id == room_id and pid in connections._by_player
                ]
                if not still_connected:
                    store.remove_room_custom_words(room_id)

