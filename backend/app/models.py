from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Dict, List, Optional
from uuid import UUID

from pydantic import BaseModel, Field


class PlayerRole(str, Enum):
    cluegiver = "cluegiver"  # загадывающий
    guesser = "guesser"  # угадывающий
    spectator = "spectator"  # наблюдатель


class GameMode(str, Enum):
    to_words = "to_words"
    to_rounds = "to_rounds"


class WordPack(str, Enum):
    simple = "simple"  # простые
    medium = "medium"   # средние
    hard = "hard"      # сложные


class GuessOutcome(str, Enum):
    correct = "correct"  # +1 очко, +1 угаданное слово
    dont_know = "dont_know"  # 0 очков
    skip = "skip"  # -1 очко


class GameConfig(BaseModel):
    mode: GameMode = GameMode.to_words
    round_seconds: int = Field(default=60, ge=10, le=600, description="секунды на раунд")
    target_words: int = Field(default=20, ge=1, le=500, description="слов для победы (режим to_words)")
    max_rounds: int = Field(default=10, ge=1, le=100, description="раундов до победы (режим to_rounds)")
    word_pack: WordPack = WordPack.medium


class WordEvent(BaseModel):
    word: str
    outcome: GuessOutcome
    at: datetime


class Room(BaseModel):
    id: UUID
    code: str
    name: str
    team_ids: List[UUID] = Field(default_factory=list)
    config: GameConfig = Field(default_factory=GameConfig)

    game_over: bool = False
    winner_team_id: Optional[UUID] = None


class Player(BaseModel):
    id: UUID
    name: str
    room_id: UUID
    role: PlayerRole
    team_id: Optional[UUID] = None


class Team(BaseModel):
    id: UUID
    room_id: UUID
    name: str
    code: str

    player_ids: List[UUID] = Field(default_factory=list)
    cluegiver_id: Optional[UUID] = None

    # игровой прогресс по словам (индекс в колоде)
    deck: List[str] = Field(default_factory=list)
    current_index: int = 0
    last_revealed_word: Optional[str] = None

    # счёт и статистика
    score: int = 0
    total_correct: int = 0

    # раунд
    round_number: int = 0
    round_active: bool = False
    round_started_at: Optional[datetime] = None
    round_ends_at: Optional[datetime] = None

    # история слов: список раундов, каждый раунд — список событий
    rounds: List[List[WordEvent]] = Field(default_factory=list)


class GameState(BaseModel):
    rooms: Dict[UUID, Room] = Field(default_factory=dict)
    teams: Dict[UUID, Team] = Field(default_factory=dict)
    players: Dict[UUID, Player] = Field(default_factory=dict)


class RoomTeamSummary(BaseModel):
    id: UUID
    name: str
    code: str
    score: int
    total_correct: int
    round_number: int
    round_active: bool
    players_count: int
    cluegiver_name: Optional[str] = None
    player_names: List[str] = Field(default_factory=list)


class RoomPublicView(BaseModel):
    id: UUID
    code: str
    name: str
    config: GameConfig
    game_over: bool
    winner_team_id: Optional[UUID]
    teams: List[RoomTeamSummary]
    spectators: List[str]
    custom_words_name: Optional[str] = None  # filename without .csv when custom pack is loaded


class TeamPrivateView(BaseModel):
    id: UUID
    name: str
    code: str
    players: List[Player]
    cluegiver_id: Optional[UUID]

    score: int
    total_correct: int
    round_number: int
    round_active: bool
    round_started_at: Optional[datetime]
    round_ends_at: Optional[datetime]
    rounds: List[List[WordEvent]]
    last_revealed_word: Optional[str]


class PlayerView(BaseModel):
    id: UUID
    name: str
    role: PlayerRole
    team_id: Optional[UUID]


class WsStateView(BaseModel):
    room: RoomPublicView
    me: PlayerView
    my_team: Optional[dict] = None  # TeamPrivateView (+ current_word for cluegiver)
    spectator_teams: Optional[List[dict]] = None  # TeamPrivateView без current_word (для наблюдателя)


class WsClientHello(BaseModel):
    type: str = "hello"
    player_id: UUID


class WsActionUpdateSettings(BaseModel):
    type: str = "update_settings"
    config: GameConfig


class WsActionStartRound(BaseModel):
    type: str = "start_round"


class WsActionEndRound(BaseModel):
    type: str = "end_round"


class WsActionMark(BaseModel):
    type: str = "mark"
    outcome: GuessOutcome


class WsActionSetWordOutcome(BaseModel):
    type: str = "set_word_outcome"
    round_index: int
    word_index: int
    outcome: GuessOutcome


class WsServerState(BaseModel):
    type: str = "state"
    view: dict


class WsServerError(BaseModel):
    type: str = "error"
    message: str

