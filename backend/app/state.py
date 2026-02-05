from __future__ import annotations

import random
import secrets
from datetime import UTC, datetime, timedelta
from typing import Dict, List, Optional, Tuple
from uuid import UUID, uuid4

from .models import (
    ActiveTeamView,
    GameConfig,
    GameMode,
    GameState,
    GuessOutcome,
    Player,
    PlayerRole,
    PlayerView,
    Room,
    RoomPublicView,
    RoomTeamSummary,
    Team,
    TeamPrivateView,
    WordEvent,
    WsStateView,
)
from .words import make_deck, make_deck_from_words


def _code(n: int = 6) -> str:
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(n))


class StateStore:
    def __init__(self) -> None:
        self.state = GameState()
        # room_id -> (display_name_without_ext, words_list); cleared when room is empty
        self.room_custom_words: Dict[UUID, Tuple[str, List[str]]] = {}

    def _ensure_can_change_word_pack(self, room_id: UUID) -> None:
        """Пак слов нельзя менять с начала первого раунда до конца игры."""
        room = self.state.rooms[room_id]
        if room.game_over:
            return
        for tid in room.team_ids:
            t = self.state.teams.get(tid)
            if t and t.round_number > 0:
                raise PermissionError("cannot_change_word_pack_after_game_started")

    def set_room_custom_words(self, room_id: UUID, name_without_ext: str, words: List[str]) -> None:
        self._ensure_can_change_word_pack(room_id)
        self.room_custom_words[room_id] = (name_without_ext, words)
        self._replace_room_decks(room_id)

    def remove_room_custom_words(self, room_id: UUID) -> None:
        self.room_custom_words.pop(room_id, None)

    def _replace_room_decks(self, room_id: UUID) -> None:
        """Обновить колоды у всех команд в комнате под текущий пак слов (свой или предустановка)."""
        room = self.state.rooms[room_id]
        custom = self.room_custom_words.get(room_id)
        pack = getattr(room.config.word_pack, "value", room.config.word_pack) if hasattr(room.config, "word_pack") else "medium"
        pack_lang = getattr(room.config.word_pack_lang, "value", getattr(room.config, "word_pack_lang", "ru")) if hasattr(room.config, "word_pack_lang") else "ru"
        for tid in room.team_ids:
            t = self.state.teams.get(tid)
            if not t:
                continue
            if custom:
                _, words = custom
                t.deck = make_deck_from_words(words, seed=str(t.id), size=600)
            else:
                t.deck = make_deck(seed=str(t.id), size=600, pack=pack, pack_lang=pack_lang)

    def create_room(self, name: str) -> Room:
        room_id = uuid4()
        room = Room(id=room_id, code=_code(6), name=name or "Комната", config=GameConfig())
        self.state.rooms[room_id] = room
        return room

    def get_room_by_code(self, code: str) -> Optional[Room]:
        for r in self.state.rooms.values():
            if r.code.upper() == code.upper():
                return r
        return None

    def create_team(self, room_id: UUID, name: str) -> Team:
        room = self.state.rooms[room_id]
        team_id = uuid4()
        custom = self.room_custom_words.get(room_id)
        if custom:
            _, words = custom
            deck = make_deck_from_words(words, seed=str(team_id), size=600)
        else:
            pack = getattr(room.config.word_pack, "value", room.config.word_pack) if hasattr(room.config, "word_pack") else "medium"
            pack_lang = getattr(room.config.word_pack_lang, "value", getattr(room.config, "word_pack_lang", "ru")) if hasattr(room.config, "word_pack_lang") else "ru"
            deck = make_deck(seed=str(team_id), size=600, pack=pack, pack_lang=pack_lang)
        team = Team(
            id=team_id,
            room_id=room_id,
            name=name or "Команда",
            code=_code(4),
            deck=deck,
        )
        self.state.teams[team_id] = team
        room.team_ids.append(team_id)
        return team

    def get_team_by_code(self, room_id: UUID, team_code: str) -> Optional[Team]:
        room = self.state.rooms[room_id]
        for tid in room.team_ids:
            t = self.state.teams.get(tid)
            if t and t.code.upper() == team_code.upper():
                return t
        return None

    def add_player(self, room_id: UUID, name: str, role: PlayerRole, team_id: Optional[UUID]) -> Player:
        player = Player(id=uuid4(), name=name or "Игрок", room_id=room_id, role=role, team_id=team_id)
        self.state.players[player.id] = player

        if team_id is not None:
            team = self.state.teams[team_id]
            team.player_ids.append(player.id)
            if role == PlayerRole.cluegiver and team.cluegiver_id is None:
                team.cluegiver_id = player.id
        return player

    def _remove_player_from_team(self, player_id: UUID) -> None:
        player = self.state.players[player_id]
        if not player.team_id:
            return
        team = self.state.teams.get(player.team_id)
        if team:
            if player.id in team.player_ids:
                team.player_ids.remove(player.id)
            if team.cluegiver_id == player.id:
                team.cluegiver_id = None
        player.team_id = None

    def remove_player(self, player_id: UUID) -> Optional[Tuple[UUID, str]]:
        """Удалить игрока из комнаты (из команды и из state). Возвращает (room_id, name) для уведомления остальных."""
        player = self.state.players.get(player_id)
        if not player:
            return None
        room_id = player.room_id
        name = player.name
        self._remove_player_from_team(player_id)
        del self.state.players[player_id]
        return (room_id, name)

    def join_team(self, player_id: UUID, team_id: UUID, role: PlayerRole = PlayerRole.guesser) -> None:
        if role == PlayerRole.spectator:
            raise ValueError("invalid_role")

        player = self.state.players[player_id]
        team = self.state.teams[team_id]
        if player.room_id != team.room_id:
            raise PermissionError("wrong_room")
        room = self.state.rooms[player.room_id]
        # После старта игры нельзя назначать загадывающего через join (только угадывающий).
        if role != PlayerRole.guesser and not room.game_over:
            for tid in room.team_ids:
                if self.state.teams[tid].round_number > 0:
                    raise PermissionError("cannot_change_role_during_game")

        # вывести из предыдущей команды (если была)
        self._remove_player_from_team(player_id)

        # добавить в новую
        player.team_id = team_id
        player.role = role
        team.player_ids.append(player_id)

        # назначение/снятие загадывающего
        if role == PlayerRole.cluegiver:
            # если в команде уже есть загадывающий — переводим его в угадывающие
            if team.cluegiver_id and team.cluegiver_id != player_id and team.cluegiver_id in self.state.players:
                self.state.players[team.cluegiver_id].role = PlayerRole.guesser
            team.cluegiver_id = player_id
        elif team.cluegiver_id == player_id:
            team.cluegiver_id = None

    def set_role(self, player_id: UUID, role: PlayerRole) -> None:
        player = self.state.players[player_id]
        room = self.state.rooms[player.room_id]
        # После старта первого раунда и до победителя роли менять нельзя.
        if not room.game_over:
            for tid in room.team_ids:
                if self.state.teams[tid].round_number > 0:
                    raise PermissionError("cannot_change_role_during_game")
        if role == PlayerRole.spectator:
            # превращаем в наблюдателя (выводим из команды)
            self._remove_player_from_team(player_id)
            player.role = PlayerRole.spectator
            return

        if not player.team_id:
            raise PermissionError("no_team")
        team = self.state.teams[player.team_id]
        if role == PlayerRole.cluegiver:
            # если в команде уже есть загадывающий — переводим его в угадывающие
            if team.cluegiver_id and team.cluegiver_id != player.id and team.cluegiver_id in self.state.players:
                self.state.players[team.cluegiver_id].role = PlayerRole.guesser
            team.cluegiver_id = player.id
        elif team.cluegiver_id == player.id:
            team.cluegiver_id = None
        player.role = role

    def randomize_room(self, room_id: UUID) -> None:
        room = self.state.rooms[room_id]
        if not room.team_ids:
            raise ValueError("no_teams")
        if not room.game_over:
            for tid in room.team_ids:
                if self.state.teams[tid].round_number > 0:
                    raise PermissionError("cannot_randomize_during_game")

        # запрещаем рандомайз, если у кого-то идёт раунд
        for tid in room.team_ids:
            t = self.state.teams[tid]
            if t.round_active:
                raise PermissionError("cannot_randomize_during_round")

        # все игроки в комнате
        player_ids = [pid for pid, p in self.state.players.items() if p.room_id == room_id]
        if not player_ids:
            return

        # очистим команды и текущие загадывающие
        for tid in room.team_ids:
            t = self.state.teams[tid]
            t.player_ids = []
            t.cluegiver_id = None

        rng = random.Random()
        rng.shuffle(player_ids)
        team_ids = list(room.team_ids)

        # Распределение по кругу (round-robin): при количестве игроков, кратном количеству
        # команд, во всех командах будет поровну; иначе — допустимо ровно на 1 больше в части команд.
        for i, pid in enumerate(player_ids):
            tid = team_ids[i % len(team_ids)]
            p = self.state.players[pid]
            p.team_id = tid
            p.role = PlayerRole.guesser
            self.state.teams[tid].player_ids.append(pid)

        n_players, n_teams = len(player_ids), len(team_ids)
        if n_teams and n_players % n_teams == 0:
            expected = n_players // n_teams
            for tid in team_ids:
                assert len(self.state.teams[tid].player_ids) == expected, "equal teams when divisible"

        # в каждой команде выбираем одного загадывающего (если есть игроки)
        for tid in team_ids:
            t = self.state.teams[tid]
            if not t.player_ids:
                continue
            cg = rng.choice(t.player_ids)
            t.cluegiver_id = cg
            self.state.players[cg].role = PlayerRole.cluegiver

    def _room_of_team(self, team_id: UUID) -> Room:
        team = self.state.teams[team_id]
        return self.state.rooms[team.room_id]

    def _ensure_can_edit_room(self, room: Room, actor_player_id: UUID) -> None:
        """Право менять настройки: только между раундами; игра не завершена; при only_cluegiver_can_edit_settings — только загадывающий."""
        actor = self.state.players[actor_player_id]
        if room.game_over:
            raise PermissionError("game_over")
        if not actor.team_id:
            raise PermissionError("only_cluegiver")  # в команде должен быть
        for tid in room.team_ids:
            t = self.state.teams.get(tid)
            if t and t.round_active:
                raise PermissionError("cannot_change_settings_during_round")
        only_cluegiver = getattr(room.config, "only_cluegiver_can_edit_settings", True)
        if only_cluegiver and actor.role != PlayerRole.cluegiver:
            raise PermissionError("only_cluegiver")

    def _ensure_can_change_win_condition(self, room_id: UUID) -> None:
        """Условие победы (режим игры) нельзя менять после начала первого раунда."""
        room = self.state.rooms[room_id]
        if room.game_over:
            return
        for tid in room.team_ids:
            t = self.state.teams.get(tid)
            if t and t.round_number > 0:
                raise PermissionError("cannot_change_win_condition_after_game_started")

    def update_settings(self, room_id: UUID, actor_player_id: UUID, config: GameConfig) -> None:
        room = self.state.rooms[room_id]
        self._ensure_can_edit_room(room, actor_player_id)
        # Время раунда и кол-во слов/раундов для победы можно менять в любой момент (кроме game_over).
        room.config.round_seconds = max(10, min(int(config.round_seconds), 600))
        room.config.target_words = max(1, min(int(config.target_words), 500))
        room.config.max_rounds = max(1, min(int(config.max_rounds), 100))
        # Режим победы — только до начала первого раунда.
        if config.mode != room.config.mode:
            self._ensure_can_change_win_condition(room_id)
        room.config.mode = config.mode
        if hasattr(config, "word_pack") and config.word_pack is not None:
            self._ensure_can_change_word_pack(room_id)
            room.config.word_pack = config.word_pack
            if room_id not in self.room_custom_words:
                self._replace_room_decks(room_id)
        if hasattr(config, "word_pack_lang") and config.word_pack_lang is not None:
            self._ensure_can_change_word_pack(room_id)
            room.config.word_pack_lang = config.word_pack_lang
            if room_id not in self.room_custom_words:
                self._replace_room_decks(room_id)
        if hasattr(config, "only_cluegiver_can_edit_settings"):
            room.config.only_cluegiver_can_edit_settings = bool(config.only_cluegiver_can_edit_settings)

    def _require_cluegiver_of_team(self, team: Team, actor_player_id: UUID) -> None:
        if team.cluegiver_id != actor_player_id:
            raise PermissionError("only_cluegiver")

    def _require_round_active(self, team: Team) -> None:
        if not team.round_active:
            raise PermissionError("round_not_active")
        # Таймер истёк — раунд не завершаем автоматически: загадывающий может
        # отметить последнее слово (Угадал / Не знаю / Пропуск), раунд завершится после этого.

    def start_round(self, team_id: UUID, actor_player_id: UUID) -> None:
        team = self.state.teams[team_id]
        room = self._room_of_team(team_id)
        if room.game_over:
            raise PermissionError("game_over")
        self._require_cluegiver_of_team(team, actor_player_id)
        if team.round_active:
            raise PermissionError("round_already_active")
        if room.config.mode == GameMode.to_rounds and team.round_number >= room.config.max_rounds:
            raise PermissionError("max_rounds_reached_for_team")
        # Не начинать раунд, пока у другой команды раунд уже идёт
        for tid in room.team_ids:
            if tid != team_id and self.state.teams.get(tid) and self.state.teams[tid].round_active:
                raise PermissionError("another_team_round_active")
        # Очерёдность: раунд 1 — команда 0, раунд 2 — команда 1, раунд 3 — команда 0, ...
        total_rounds = sum(
            self.state.teams[tid].round_number for tid in room.team_ids if self.state.teams.get(tid)
        )
        next_index = total_rounds % len(room.team_ids)
        team_that_can_start = room.team_ids[next_index]
        if team_id != team_that_can_start:
            raise PermissionError("not_your_turn")

        team.round_number += 1
        team.round_active = True
        team.round_started_at = datetime.now(UTC)
        team.round_ends_at = team.round_started_at + timedelta(seconds=room.config.round_seconds)
        team.rounds.append([])

    def end_round(self, team_id: UUID) -> None:
        team = self.state.teams[team_id]
        if not team.round_active:
            return
        team.round_active = False
        team.round_started_at = None
        team.round_ends_at = None
        self._rotate_cluegiver(team_id)
        self._maybe_finish_room(self._room_of_team(team_id))

    def _rotate_cluegiver(self, team_id: UUID) -> None:
        """После окончания раунда передать роль загадывающего следующему игроку по кругу."""
        team = self.state.teams[team_id]
        if not team.player_ids or not team.cluegiver_id:
            return
        try:
            idx = team.player_ids.index(team.cluegiver_id)
        except ValueError:
            return
        next_idx = (idx + 1) % len(team.player_ids)
        next_player_id = team.player_ids[next_idx]
        if next_player_id == team.cluegiver_id:
            return  # один игрок — не меняем
        old_cg = team.cluegiver_id
        team.cluegiver_id = next_player_id
        if old_cg in self.state.players:
            self.state.players[old_cg].role = PlayerRole.guesser
        if next_player_id in self.state.players:
            self.state.players[next_player_id].role = PlayerRole.cluegiver

    def _apply_scoring(self, team: Team, outcome: GuessOutcome) -> None:
        if outcome == GuessOutcome.correct:
            team.score += 1
            team.total_correct += 1
        elif outcome == GuessOutcome.dont_know:
            team.score += 0
        elif outcome == GuessOutcome.skip:
            team.score -= 1

    def mark_word(self, team_id: UUID, actor_player_id: UUID, outcome: GuessOutcome) -> None:
        team = self.state.teams[team_id]
        room = self._room_of_team(team_id)
        if room.game_over:
            raise PermissionError("game_over")
        self._require_cluegiver_of_team(team, actor_player_id)
        self._require_round_active(team)

        current = self.current_word(team_id)
        if not current:
            raise ValueError("no_word")

        ev = WordEvent(word=current, outcome=outcome, at=datetime.now(UTC))
        if not team.rounds:
            team.rounds.append([])
        team.rounds[-1].append(ev)
        team.last_revealed_word = current
        self._apply_scoring(team, outcome)

        # победа по словам
        if room.config.mode == GameMode.to_words and team.total_correct >= room.config.target_words:
            room.game_over = True
            room.winner_team_id = team.id
            self.end_round(team_id)

        team.current_index = min(team.current_index + 1, max(0, len(team.deck) - 1))
        # После отметки слова: если таймер уже истёк, это было последнее слово — завершаем раунд
        if team.round_ends_at and datetime.now(UTC) > team.round_ends_at:
            self.end_round(team_id)
        self._maybe_finish_room(room)

    def _maybe_finish_room(self, room: Room) -> None:
        if room.game_over:
            return
        if room.config.mode != GameMode.to_rounds:
            return
        # игра до раундов завершается когда все команды отыграли max_rounds и никто не в раунде
        for tid in room.team_ids:
            t = self.state.teams[tid]
            if t.round_active:
                return
            if t.round_number < room.config.max_rounds:
                return
        room.game_over = True
        # победитель по максимальному score
        best = max((self.state.teams[tid] for tid in room.team_ids), key=lambda t: t.score, default=None)
        room.winner_team_id = best.id if best else None

    def current_word(self, team_id: UUID) -> Optional[str]:
        team = self.state.teams[team_id]
        if not team.deck:
            return None
        idx = max(0, min(team.current_index, len(team.deck) - 1))
        return team.deck[idx]

    def _recalculate_team_score(self, team_id: UUID) -> None:
        """Пересчитать счёт команды по всем раундам (словам)."""
        team = self.state.teams[team_id]
        score = 0
        total_correct = 0
        for round_events in team.rounds:
            for ev in round_events:
                if ev.outcome == GuessOutcome.correct:
                    score += 1
                    total_correct += 1
                elif ev.outcome == GuessOutcome.skip:
                    score -= 1
        team.score = score
        team.total_correct = total_correct

    def set_round_word_outcome(
        self, team_id: UUID, actor_player_id: UUID, round_idx: int, word_idx: int, outcome: GuessOutcome
    ) -> None:
        """Изменить исход слова в завершённом раунде (для ручной корректировки очков)."""
        team = self.state.teams[team_id]
        room = self._room_of_team(team_id)
        if room.game_over:
            raise PermissionError("game_over")
        if actor_player_id not in team.player_ids:
            raise PermissionError("not_in_team")
        if team.round_active:
            raise PermissionError("round_active")
        if round_idx < 0 or round_idx >= len(team.rounds):
            raise ValueError("invalid_round")
        round_events = team.rounds[round_idx]
        if word_idx < 0 or word_idx >= len(round_events):
            raise ValueError("invalid_word")
        ev = round_events[word_idx]
        round_events[word_idx] = WordEvent(word=ev.word, outcome=outcome, at=ev.at)
        self._recalculate_team_score(team_id)
        if room.config.mode == GameMode.to_words and team.total_correct >= room.config.target_words:
            room.game_over = True
            room.winner_team_id = team.id
        self._maybe_finish_room(room)

    def restart_room(self, room_id: UUID, actor_player_id: UUID) -> None:
        room = self.state.rooms[room_id]
        actor = self.state.players.get(actor_player_id)
        if not actor or actor.room_id != room_id:
            raise PermissionError("wrong_room")
        if actor.role != PlayerRole.cluegiver or not actor.team_id:
            raise PermissionError("only_cluegiver")

        # сбрасываем состояние комнаты (можно перезапускать и во время игры)
        room.game_over = False
        room.winner_team_id = None

        # все игроки переходят в «Игроки без команды»
        for p in list(self.state.players.values()):
            if p.room_id != room_id:
                continue
            self._remove_player_from_team(p.id)
            p.role = PlayerRole.spectator

        # сбрасываем прогресс всех команд
        for tid in list(room.team_ids):
            t = self.state.teams.get(tid)
            if not t:
                continue
            t.player_ids.clear()
            t.cluegiver_id = None
            t.score = 0
            t.total_correct = 0
            t.round_number = 0
            t.round_active = False
            t.round_started_at = None
            t.round_ends_at = None
            t.rounds = []
            t.last_revealed_word = None
            t.current_index = 0

    def room_public_view(self, room_id: UUID) -> RoomPublicView:
        room = self.state.rooms[room_id]
        teams: List[RoomTeamSummary] = []
        for tid in room.team_ids:
            t = self.state.teams[tid]
            cluegiver_name: Optional[str] = None
            if t.cluegiver_id and t.cluegiver_id in self.state.players:
                cluegiver_name = self.state.players[t.cluegiver_id].name
            player_names = [self.state.players[pid].name for pid in t.player_ids if pid in self.state.players]
            teams.append(
                RoomTeamSummary(
                    id=t.id,
                    name=t.name,
                    code=t.code,
                    score=t.score,
                    total_correct=t.total_correct,
                    round_number=t.round_number,
                    round_active=t.round_active,
                    players_count=len(t.player_ids),
                    cluegiver_name=cluegiver_name,
                    player_names=player_names,
                )
            )
        spectators = [p.name for p in self.state.players.values() if p.room_id == room_id and p.role == PlayerRole.spectator]
        custom_name: Optional[str] = None
        if room_id in self.room_custom_words:
            custom_name = self.room_custom_words[room_id][0]
        return RoomPublicView(
            id=room.id,
            code=room.code,
            name=room.name,
            config=room.config,
            game_over=room.game_over,
            winner_team_id=room.winner_team_id,
            teams=teams,
            spectators=spectators,
            custom_words_name=custom_name,
        )

    def team_private_view(self, team_id: UUID) -> TeamPrivateView:
        team = self.state.teams[team_id]
        players = [self.state.players[pid] for pid in team.player_ids if pid in self.state.players]
        return TeamPrivateView(
            id=team.id,
            name=team.name,
            code=team.code,
            players=players,
            cluegiver_id=team.cluegiver_id,
            score=team.score,
            total_correct=team.total_correct,
            round_number=team.round_number,
            round_active=team.round_active,
            round_started_at=team.round_started_at,
            round_ends_at=team.round_ends_at,
            rounds=team.rounds,
            last_revealed_word=team.last_revealed_word,
        )

    def view_for_player(self, player_id: UUID) -> dict:
        if player_id not in self.state.players:
            raise KeyError("player_not_found")
        player = self.state.players[player_id]
        room_view = self.room_public_view(player.room_id)
        me = PlayerView(id=player.id, name=player.name, role=player.role, team_id=player.team_id)

        my_team: Optional[dict] = None
        spectator_teams: Optional[list] = None
        if player.team_id:
            t_view = self.team_private_view(player.team_id)
            base = t_view.model_dump(mode="json")
            # current_word только для загадывающего своей команды
            if self.state.teams[player.team_id].cluegiver_id == player.id and player.role == PlayerRole.cluegiver:
                base["current_word"] = self.current_word(player.team_id)
            my_team = base
        elif player.role == PlayerRole.spectator:
            spectator_teams = [self.team_private_view(tid).model_dump(mode="json") for tid in self.state.rooms[player.room_id].team_ids]

        room = self.state.rooms[player.room_id]
        active_team = None
        for tid in room.team_ids:
            t = self.state.teams.get(tid)
            if t and t.round_active:
                active_team = ActiveTeamView(id=t.id, name=t.name, rounds=t.rounds, round_ends_at=t.round_ends_at)
                break

        total_rounds = sum(
            self.state.teams[tid].round_number for tid in room.team_ids if self.state.teams.get(tid)
        )
        can_start_round_team_id = None
        if room.team_ids:
            next_idx = total_rounds % len(room.team_ids)
            can_start_round_team_id = room.team_ids[next_idx]

        return WsStateView(
            room=room_view,
            me=me,
            my_team=my_team,
            spectator_teams=spectator_teams,
            active_team=active_team,
            can_start_round_team_id=can_start_round_team_id,
        ).model_dump(mode="json")

