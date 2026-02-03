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

# Ukrainian (fallback lists; can add words_simple_500_uk.csv etc. later)
SIMPLE_WORDS_UK: List[str] = [
    "Дім", "Кіт", "Стіл", "М'яч", "Мама", "Тато", "Сонце", "Вода", "Хліб", "Молоко",
    "Собака", "Птах", "Риба", "Яблуко", "Книга", "Стілець", "Вікно", "Двері", "Нога", "Рука",
    "Око", "Ніс", "Рот", "Вухо", "Голова", "Сніг", "Дощ", "Вогонь", "Квітка", "Дерево",
    "Машина", "Поїзд", "Годинник", "Телефон", "Ложка", "Тарілка", "Чашка", "Ліжко", "Лампа", "Дзеркало",
]
MEDIUM_WORDS_UK: List[str] = [
    "Літак", "Мікрофон", "Олівець", "Сніговик", "Пилосос", "Космонавт", "Бібліотека", "Кавоварка",
    "Скейтборд", "Телескоп", "Подушка", "Шахи", "Календар", "Компас", "Ліхтарик", "Акваріум",
    "Термометр", "Вертоліт", "Крокодил", "Рюкзак", "Цукерниця", "Рукавички", "Піаніно", "Світлофор",
]
HARD_WORDS_UK: List[str] = [
    "Абстракція", "Парадокс", "Критерій", "Гіпотеза", "Синтез", "Аналіз", "Контекст", "Аналогія",
    "Інтуїція", "Принцип", "Концепція", "Парадигма", "Дилема", "Іронія", "Метафора", "Символ",
]

# English
SIMPLE_WORDS_EN: List[str] = [
    "House", "Cat", "Table", "Ball", "Mom", "Dad", "Sun", "Water", "Bread", "Milk",
    "Dog", "Bird", "Fish", "Apple", "Book", "Chair", "Window", "Door", "Leg", "Hand",
    "Eye", "Nose", "Mouth", "Ear", "Head", "Snow", "Rain", "Fire", "Flower", "Tree",
    "Car", "Train", "Clock", "Phone", "Spoon", "Plate", "Cup", "Bed", "Lamp", "Mirror",
]
MEDIUM_WORDS_EN: List[str] = [
    "Airplane", "Microphone", "Pencil", "Snowman", "Vacuum", "Astronaut", "Library", "Coffee maker",
    "Skateboard", "Telescope", "Pillow", "Chess", "Calendar", "Compass", "Flashlight", "Aquarium",
    "Thermometer", "Helicopter", "Crocodile", "Backpack", "Sugar bowl", "Gloves", "Piano", "Traffic light",
]
HARD_WORDS_EN: List[str] = [
    "Abstraction", "Paradox", "Criterion", "Hypothesis", "Synthesis", "Analysis", "Context", "Analogy",
    "Intuition", "Principle", "Concept", "Paradigm", "Dilemma", "Irony", "Metaphor", "Symbol",
]


def _words_for_pack(pack: str, pack_lang: str = "ru") -> List[str]:
    if pack_lang == "uk":
        if pack == "simple":
            return list(SIMPLE_WORDS_UK)
        if pack == "hard":
            return list(HARD_WORDS_UK)
        return list(MEDIUM_WORDS_UK)
    if pack_lang == "en":
        if pack == "simple":
            return list(SIMPLE_WORDS_EN)
        if pack == "hard":
            return list(HARD_WORDS_EN)
        return list(MEDIUM_WORDS_EN)
    if pack == "simple":
        return list(SIMPLE_WORDS_RU)
    if pack == "hard":
        return list(HARD_WORDS_RU)
    return list(MEDIUM_WORDS_RU)


def make_deck(seed: str, size: int = 200, pack: str = "medium", pack_lang: str = "ru") -> List[str]:
    rng = random.Random(seed)
    words = _words_for_pack(pack, pack_lang)
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
        return make_deck(seed=seed, size=size, pack="medium", pack_lang="ru")
    rng = random.Random(seed)
    words = [w.strip() for w in words if w and w.strip()]
    if not words:
        return make_deck(seed=seed, size=size, pack="medium", pack_lang="ru")
    rng.shuffle(words)
    deck: List[str] = []
    while len(deck) < size:
        for w in words:
            deck.append(w)
            if len(deck) >= size:
                break
        rng.shuffle(words)
    return deck

