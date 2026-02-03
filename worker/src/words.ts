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

// Українська
const SIMPLE_WORDS_UK = [
  'Дім', 'Кіт', 'Стіл', 'М\'яч', 'Мама', 'Тато', 'Сонце', 'Вода', 'Хліб', 'Молоко',
  'Собака', 'Птах', 'Риба', 'Яблуко', 'Книга', 'Стілець', 'Вікно', 'Двері', 'Нога', 'Рука',
  'Око', 'Ніс', 'Рот', 'Вухо', 'Голова', 'Сніг', 'Дощ', 'Вогонь', 'Квітка', 'Дерево',
  'Машина', 'Поїзд', 'Годинник', 'Телефон', 'Ложка', 'Тарілка', 'Чашка', 'Ліжко', 'Лампа', 'Дзеркало',
  'Ключ', 'Шапка', 'Плаття', 'Черевик', 'Сумка', 'Окуляри', 'Парасолька', 'Ніж', 'Вилка', 'Олівець',
  'Папір', 'Фарба', 'Іграшка', 'Кукла', 'Ведмідь', 'Заєць', 'Лисиця', 'Вовк', 'Ведмідь',
]

const MEDIUM_WORDS_UK = [
  'Літак', 'Мікрофон', 'Олівець', 'Сніговик', 'Пилосос', 'Космонавт', 'Бібліотека', 'Кавоварка',
  'Скейтборд', 'Телескоп', 'Подушка', 'Шахи', 'Календар', 'Компас', 'Ліхтарик', 'Акваріум',
  'Термометр', 'Вертоліт', 'Крокодил', 'Рюкзак', 'Цукерниця', 'Рукавички', 'Піаніно', 'Світлофор',
  'Парасолька', 'Апельсин', 'Магніт', 'Кошеня', 'Серветка', 'Морозиво', 'Чоботи', 'Кукурудза',
  'Собака', 'Лавка', 'Робот', 'Пароплав', 'Бутерброд', 'Капуста', 'Телефон', 'Будильник',
  'Гітара', 'Барабан', 'Вентилятор', 'Глобус', 'Диркопробивач', 'Калькулятор', 'Конверт', 'Лейка',
  'Молоток', 'Відвертка', 'Плед', 'Свічка', 'Термос', 'Ліхтар', 'Шафа', 'Дзига', 'Якір',
]

const HARD_WORDS_UK = [
  'Абстракція', 'Парадокс', 'Критерій', 'Гіпотеза', 'Синтез', 'Аналіз', 'Контекст', 'Аналогія',
  'Інтуїція', 'Принцип', 'Концепція', 'Парадигма', 'Дилема', 'Іронія', 'Метафора', 'Символ',
  'Тезис', 'Аргумент', 'Висновок', 'Умова', 'Наслідок', 'Причина', 'Результат', 'Критерій',
  'Обмеження', 'Виключення', 'Варіант', 'Альтернатива', 'Компроміс', 'Суперечність', 'Нюанс',
  'Відтінок', 'Підтекст', 'Підхід', 'Метод', 'Стратегія', 'Тактика', 'Ресурс', 'Потенціал',
  'Динаміка', 'Статика', 'Структура', 'Система', 'Елемент', 'Компонент', 'Фактор', 'Аспект',
  'Показник', 'Індикатор', 'Параметр', 'Характеристика', 'Властивість', 'Ознака',
]

// English
const SIMPLE_WORDS_EN = [
  'House', 'Cat', 'Table', 'Ball', 'Mom', 'Dad', 'Sun', 'Water', 'Bread', 'Milk',
  'Dog', 'Bird', 'Fish', 'Apple', 'Book', 'Chair', 'Window', 'Door', 'Leg', 'Hand',
  'Eye', 'Nose', 'Mouth', 'Ear', 'Head', 'Snow', 'Rain', 'Fire', 'Flower', 'Tree',
  'Car', 'Train', 'Clock', 'Phone', 'Spoon', 'Plate', 'Cup', 'Bed', 'Lamp', 'Mirror',
  'Key', 'Hat', 'Dress', 'Shoe', 'Bag', 'Glasses', 'Umbrella', 'Knife', 'Fork', 'Pencil',
  'Paper', 'Paint', 'Toy', 'Doll', 'Bear', 'Rabbit', 'Fox', 'Wolf', 'Bear',
]

const MEDIUM_WORDS_EN = [
  'Airplane', 'Microphone', 'Pencil', 'Snowman', 'Vacuum', 'Astronaut', 'Library', 'Coffee maker',
  'Skateboard', 'Telescope', 'Pillow', 'Chess', 'Calendar', 'Compass', 'Flashlight', 'Aquarium',
  'Thermometer', 'Helicopter', 'Crocodile', 'Backpack', 'Sugar bowl', 'Gloves', 'Piano', 'Traffic light',
  'Umbrella', 'Orange', 'Magnet', 'Kitten', 'Napkin', 'Ice cream', 'Boots', 'Corn',
  'Dog', 'Bench', 'Robot', 'Steamer', 'Sandwich', 'Cabbage', 'Phone', 'Alarm clock',
  'Guitar', 'Drum', 'Fan', 'Globe', 'Hole punch', 'Calculator', 'Envelope', 'Watering can',
  'Hammer', 'Screwdriver', 'Blanket', 'Candle', 'Thermos', 'Lantern', 'Wardrobe', 'Top', 'Anchor',
]

const HARD_WORDS_EN = [
  'Abstraction', 'Paradox', 'Criterion', 'Hypothesis', 'Synthesis', 'Analysis', 'Context', 'Analogy',
  'Intuition', 'Principle', 'Concept', 'Paradigm', 'Dilemma', 'Irony', 'Metaphor', 'Symbol',
  'Thesis', 'Argument', 'Conclusion', 'Condition', 'Consequence', 'Cause', 'Result', 'Criterion',
  'Limitation', 'Exception', 'Option', 'Alternative', 'Compromise', 'Contradiction', 'Nuance',
  'Shade', 'Subtext', 'Approach', 'Method', 'Strategy', 'Tactic', 'Resource', 'Potential',
  'Dynamics', 'Statics', 'Structure', 'System', 'Element', 'Component', 'Factor', 'Aspect',
  'Indicator', 'Parameter', 'Characteristic', 'Property', 'Feature',
]

type WordPackLang = 'ru' | 'uk' | 'en'

function wordsForPack(pack: string, lang: WordPackLang = 'ru'): string[] {
  if (lang === 'uk') {
    if (pack === 'simple') return [...SIMPLE_WORDS_UK]
    if (pack === 'hard') return [...HARD_WORDS_UK]
    return [...MEDIUM_WORDS_UK]
  }
  if (lang === 'en') {
    if (pack === 'simple') return [...SIMPLE_WORDS_EN]
    if (pack === 'hard') return [...HARD_WORDS_EN]
    return [...MEDIUM_WORDS_EN]
  }
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

export function makeDeck(seed: string, size: number = 200, pack: string = 'medium', packLang: WordPackLang = 'ru'): string[] {
  let words = wordsForPack(pack, packLang)
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
  if (list.length === 0) return makeDeck(seed, size, 'medium', 'ru')
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
