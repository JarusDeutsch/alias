/** Колоды слов по пакетам (совместимо с backend/words.py). */

const SIMPLE_WORDS_RU = [
  'Дом', 'Кот', 'Стол', 'Мяч', 'Мама', 'Папа', 'Солнце', 'Вода', 'Хлеб', 'Молоко',
  'Собака', 'Птица', 'Рыба', 'Яблоко', 'Книга', 'Стул', 'Окно', 'Дверь', 'Нога', 'Рука',
  'Глаз', 'Нос', 'Рот', 'Ухо', 'Голова', 'Снег', 'Дождь', 'Огонь', 'Цветок', 'Дерево',
  'Машина', 'Поезд', 'Часы', 'Телефон', 'Ложка', 'Тарелка', 'Чашка', 'Кровать', 'Лампа', 'Зеркало',
  'Ключ', 'Шапка', 'Платье', 'Ботинок', 'Сумка', 'Очки', 'Зонт', 'Нож', 'Вилка', 'Карандаш',
  'Бумага', 'Краска', 'Игрушка', 'Мяч', 'Кукла', 'Мишка', 'Заяц', 'Лиса', 'Волк', 'Медведь',
]

const MEDIUM_WORDS_RU = [
  'Самолёт', 'Микрофон', 'Карандаш', 'Снеговик', 'Пылесос', 'Космонавт', 'Библиотека', 'Кофеварка',
  'Скейтборд', 'Телескоп', 'Подушка', 'Шахматы', 'Календарь', 'Компас', 'Фонарик', 'Аквариум',
  'Термометр', 'Вертолёт', 'Крокодил', 'Рюкзак', 'Сахарница', 'Перчатки', 'Пианино', 'Светофор',
  'Зонтик', 'Апельсин', 'Магнит', 'Котёнок', 'Салфетка', 'Мороженое', 'Сапоги', 'Кукуруза',
  'Собака', 'Скамейка', 'Робот', 'Пароход', 'Бутерброд', 'Капуста', 'Телефон', 'Будильник',
  'Гитара', 'Барабан', 'Вентилятор', 'Глобус', 'Дырокол', 'Калькулятор', 'Конверт', 'Лейка',
  'Молоток', 'Отвёртка', 'Плед', 'Свеча', 'Термос', 'Фонарь', 'Шкаф', 'Юла', 'Якорь',
]

const HARD_WORDS_RU = [
  'Абстракция', 'Парадокс', 'Критерий', 'Гипотеза', 'Синтез', 'Анализ', 'Контекст', 'Аналогия',
  'Интуиция', 'Принцип', 'Концепция', 'Парадигма', 'Дилемма', 'Ирония', 'Метафора', 'Символ',
  'Тезис', 'Аргумент', 'Вывод', 'Условие', 'Следствие', 'Причина', 'Результат', 'Критерий',
  'Ограничение', 'Исключение', 'Вариант', 'Альтернатива', 'Компромисс', 'Противоречие', 'Нюанс',
  'Оттенок', 'Подтекст', 'Подход', 'Метод', 'Стратегия', 'Тактика', 'Ресурс', 'Потенциал',
  'Динамика', 'Статика', 'Структура', 'Система', 'Элемент', 'Компонент', 'Фактор', 'Аспект',
  'Критерий', 'Показатель', 'Индикатор', 'Параметр', 'Характеристика', 'Свойство', 'Признак',
]

function wordsForPack(pack: string): string[] {
  if (pack === 'simple') return [...SIMPLE_WORDS_RU]
  if (pack === 'hard') return [...HARD_WORDS_RU]
  return [...MEDIUM_WORDS_RU]
}

/** Простой seeded shuffle (для детерминированных колод). */
function shuffleWithSeed<T>(arr: T[], seed: string): T[] {
  const out = [...arr]
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h << 5) - h + seed.charCodeAt(i) | 0
  const rng = () => {
    h = Math.imul(h ^ (h >>> 2), 0x9e3779b9)
    return (h >>> 0) / 0xffffffff
  }
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

export function makeDeck(seed: string, size: number = 200, pack: string = 'medium'): string[] {
  let words = wordsForPack(pack)
  const deck: string[] = []
  while (deck.length < size) {
    words = shuffleWithSeed(words, seed + deck.length)
    for (const w of words) {
      deck.push(w)
      if (deck.length >= size) break
    }
  }
  return deck
}

export function makeDeckFromWords(words: string[], seed: string, size: number = 600): string[] {
  const list = words.filter(w => w && w.trim()).map(w => w.trim())
  if (list.length === 0) return makeDeck(seed, size)
  const deck: string[] = []
  while (deck.length < size) {
    const shuffled = shuffleWithSeed(list, seed + deck.length)
    for (const w of shuffled) {
      deck.push(w)
      if (deck.length >= size) break
    }
  }
  return deck
}
