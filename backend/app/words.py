from __future__ import annotations

import random
import re
from pathlib import Path
from typing import List

# Простые — самые частые и лёгкие для объяснения (fallback по умолчанию)
SIMPLE_WORDS_RU_DEFAULT: List[str] = [
    "Дом", "Кот", "Стол", "Мяч", "Мама", "Папа", "Солнце", "Вода", "Хлеб", "Молоко",
    "Собака", "Птица", "Рыба", "Яблоко", "Книга", "Стул", "Окно", "Дверь", "Нога", "Рука",
    "Глаз", "Нос", "Рот", "Ухо", "Голова", "Снег", "Дождь", "Огонь", "Цветок", "Дерево",
    "Машина", "Поезд", "Часы", "Телефон", "Ложка", "Тарелка", "Чашка", "Кровать", "Лампа", "Зеркало",
    "Ключ", "Шапка", "Платье", "Ботинок", "Сумка", "Очки", "Зонт", "Нож", "Вилка", "Карандаш",
    "Бумага", "Краска", "Игрушка", "Мяч", "Кукла", "Мишка", "Заяц", "Лиса", "Волк", "Медведь",
]

# Средние — привычные предметы и понятия (fallback по умолчанию)
MEDIUM_WORDS_RU_DEFAULT: List[str] = [
    "Самолёт", "Микрофон", "Карандаш", "Снеговик", "Пылесос", "Космонавт", "Библиотека", "Кофеварка",
    "Скейтборд", "Телескоп", "Подушка", "Шахматы", "Календарь", "Компас", "Фонарик", "Аквариум",
    "Термометр", "Вертолёт", "Крокодил", "Рюкзак", "Сахарница", "Перчатки", "Пианино", "Светофор",
    "Зонтик", "Апельсин", "Магнит", "Котёнок", "Салфетка", "Мороженое", "Сапоги", "Кукуруза",
    "Собака", "Скамейка", "Робот", "Пароход", "Бутерброд", "Капуста", "Телефон", "Будильник",
    "Гитара", "Барабан", "Вентилятор", "Глобус", "Дырокол", "Калькулятор", "Конверт", "Лейка",
    "Молоток", "Отвёртка", "Плед", "Свеча", "Термос", "Фонарь", "Шкаф", "Юла", "Якорь",
]

# Сложные — абстрактные или реже встречающиеся (fallback по умолчанию)
HARD_WORDS_RU_DEFAULT: List[str] = [
    "Абстракция", "Парадокс", "Критерий", "Гипотеза", "Синтез", "Анализ", "Контекст", "Аналогия",
    "Интуиция", "Принцип", "Концепция", "Парадигма", "Дилемма", "Ирония", "Метафора", "Символ",
    "Тезис", "Аргумент", "Вывод", "Условие", "Следствие", "Причина", "Результат", "Критерий",
    "Ограничение", "Исключение", "Вариант", "Альтернатива", "Компромисс", "Противоречие", "Нюанс",
    "Оттенок", "Подтекст", "Подход", "Метод", "Стратегия", "Тактика", "Ресурс", "Потенциал",
    "Динамика", "Статика", "Структура", "Система", "Элемент", "Компонент", "Фактор", "Аспект",
    "Критерий", "Показатель", "Индикатор", "Параметр", "Характеристика", "Свойство", "Признак",
]


_ROOT_DIR = Path(__file__).resolve().parents[2]


def _load_words_csv(filename: str, fallback: List[str]) -> List[str]:
    """
    Загружаем слова из CSV (по одному слову на строку) для предустановленных паков.
    Разрешаем слова с дефисом, но отбрасываем варианты с пробелами (две и более слов).
    """
    path = _ROOT_DIR / filename
    try:
        words: List[str] = []
        with path.open("r", encoding="utf-8") as f:
            for line in f:
                w = line.strip()
                if not w:
                    continue
                # Слова через дефис — можно, пробелы — нельзя
                if re.search(r"\s", w):
                    continue
                words.append(w)
        # Если CSV пустой или после фильтрации ничего не осталось — используем fallback
        return words or list(fallback)
    except FileNotFoundError:
        return list(fallback)


SIMPLE_WORDS_RU: List[str] = _load_words_csv("words_simple_500.csv", SIMPLE_WORDS_RU_DEFAULT)
MEDIUM_WORDS_RU: List[str] = _load_words_csv("words_medium_500.csv", MEDIUM_WORDS_RU_DEFAULT)
HARD_WORDS_RU: List[str] = _load_words_csv("words_hard_500.csv", HARD_WORDS_RU_DEFAULT)


def _words_for_pack(pack: str) -> List[str]:
    if pack == "simple":
        return list(SIMPLE_WORDS_RU)
    if pack == "hard":
        return list(HARD_WORDS_RU)
    return list(MEDIUM_WORDS_RU)


def make_deck(seed: str, size: int = 200, pack: str = "medium") -> List[str]:
    rng = random.Random(seed)
    words = _words_for_pack(pack)
    rng.shuffle(words)
    deck: List[str] = []
    while len(deck) < size:
        for w in words:
            deck.append(w)
            if len(deck) >= size:
                break
        rng.shuffle(words)
    return deck


def make_deck_from_words(words: List[str], seed: str, size: int = 600) -> List[str]:
    """Build a deck from a custom word list (e.g. from CSV). Repeats/shuffles to reach size."""
    if not words:
        return make_deck(seed=seed, size=size)
    rng = random.Random(seed)
    words = [w.strip() for w in words if w and w.strip()]
    if not words:
        return make_deck(seed=seed, size=size)
    rng.shuffle(words)
    deck: List[str] = []
    while len(deck) < size:
        for w in words:
            deck.append(w)
            if len(deck) >= size:
                break
        rng.shuffle(words)
    return deck

