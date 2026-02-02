# Деплой Alias Web на Cloudflare Pages и Workers

Проект состоит из двух частей:

- **Фронтенд** (Vite + TypeScript) — раздаётся через **Cloudflare Pages** (статический сайт).
- **Бэкенд** (API + WebSocket) — работает как **Cloudflare Worker** с **Durable Object** (состояние комнат и игроков).

Ниже — пошаговая подготовка и деплой.

---

## Требования

- [Node.js](https://nodejs.org/) 18+
- Аккаунт [Cloudflare](https://dash.cloudflare.com/sign-up)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (ставится через npm в проекте)

---

## 1. Подготовка репозитория

Убедитесь, что в корне есть:

- `frontend/` — фронтенд на Vite
- `worker/` — Cloudflare Worker с Durable Object

Переменная окружения для фронтенда:

- **`VITE_API_BASE`** — базовый URL API и WebSocket. В продакшене укажите URL вашего Worker (см. шаг 3). Если не задана, в браузере используется `http://localhost:8000` (для локальной разработки с Python-бэкендом).

---

## 2. Деплой Worker (API + WebSocket)

Worker обрабатывает все запросы к `/api/*` и `/ws` и хранит состояние в Durable Object.

### 2.1. Установка зависимостей и вход в Cloudflare

```powershell
cd worker
npm install
npx wrangler login
```

Появится окно браузера для входа в аккаунт Cloudflare.

### 2.2. Публикация Worker

```powershell
npx wrangler deploy
```

После успешного деплоя в консоли будет указан URL, например:

```text
https://alias-api.wadimsergeew190405.workers.dev
```

Это и есть **базовый URL API**. Он уже прописан в `frontend/.env.production` — при сборке фронтенда (`npm run build`) он подставится автоматически. При деплое через Pages в Dashboard задайте ту же переменную **VITE_API_BASE** (шаг 4).

### 2.3. (Опционально) Свой домен для Worker

В `worker/wrangler.toml` можно задать маршрут:

```toml
routes = [
  { pattern = "api.yourdomain.com", zone_name = "yourdomain.com" }
]
```

Тогда API будет доступно по `https://api.yourdomain.com`, и этот URL нужно использовать в `VITE_API_BASE`.

---

## 3. Деплой фронтенда на Cloudflare Pages

### Вариант A: Деплой через Git (рекомендуется)

1. Залить код в GitHub/GitLab.
2. В [Cloudflare Dashboard](https://dash.cloudflare.com) → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
3. Выбрать репозиторий и ветку.
4. Настроить сборку:
   - **Framework preset:** None
   - **Build command:** `cd frontend && npm ci && npm run build`
   - **Build output directory:** `frontend/dist`
5. В **Settings** → **Environment variables** добавить переменную для **Production** (и при необходимости для Preview):
   - **Variable name:** `VITE_API_BASE`
   - **Value:** `https://alias-api.wadimsergeew190405.workers.dev` (URL вашего Worker без завершающего слеша)
6. Сохранить и запустить деплой. После сборки сайт будет доступен по адресу вида `https://<имя-проекта>.pages.dev`.

### Вариант B: Деплой через Wrangler (папка `frontend/dist`)

1. Собрать фронтенд с нужным API URL:

   ```powershell
   cd frontend
   npm ci
   npm run build
   ```
   (URL Worker уже задан в `frontend/.env.production`. Или задать вручную: `$env:VITE_API_BASE = "https://alias-api.wadimsergeew190405.workers.dev"`)

2. Опубликовать содержимое `frontend/dist` в Pages:

   ```powershell
   npx wrangler pages deploy frontend/dist --project-name=alias-web
   ```

   Или через Dashboard: **Workers & Pages** → **Create** → **Pages** → **Upload assets** и загрузить архив с содержимым `frontend/dist`.

---

## 4. Проверка после деплоя

1. Откройте URL фронтенда (Pages).
2. Создайте комнату, зайдите в неё, при необходимости создайте команду и присоединитесь.
3. Убедитесь, что состояние обновляется (слова, раунды, очки) и что второй игрок в другой вкладке/устройстве видит те же данные (WebSocket и API идут на Worker).

Если что-то не работает:

- Проверьте, что в сборке фронтенда действительно задана переменная `VITE_API_BASE` с URL Worker (без слеша в конце).
- В DevTools (Network) убедитесь, что запросы уходят на ваш Worker (`/api/rooms`, `/ws` и т.д.) и что ответы приходят без CORS-ошибок.

---

## 5. Один домен для фронтенда и API (опционально)

Если нужен один домен (например, `alias.yourdomain.com` и API по `https://alias.yourdomain.com/api`, `https://alias.yourdomain.com/ws`):

1. Настройте **Pages** на свой домен (например, `alias.yourdomain.com`).
2. Опубликуйте **Worker** на тот же домен с путями `/api/*` и `/ws` (через `routes` в `wrangler.toml` или через **Workers for Platforms** / **Custom Domains** так, чтобы Worker обрабатывал только эти пути).
3. Соберите фронтенд с пустым `VITE_API_BASE` (или не задавайте его), чтобы запросы шли на тот же origin:

   ```powershell
   $env:VITE_API_BASE = ""
   npm run build
   ```

Точная настройка маршрутов и привязки Worker к домену делается в Dashboard (Triggers, Routes, Custom Domains) под вашей зоной.

---

## 6. Локальная разработка

- **Фронтенд:**  
  `cd frontend && npm run dev`  
  По умолчанию используется `http://localhost:8000` для API/WS (если не задан `VITE_API_BASE`).

- **Бэкенд (Python):**  
  Запуск FastAPI как в README — фронтенд в dev-режиме к нему подключится.

- **Worker локально:**  
  `cd worker && npx wrangler dev`  
  В другом терминале во фронтенде задайте `VITE_API_BASE=http://localhost:8787` и запустите `npm run dev`, чтобы тестировать фронт против Worker.

---

## Краткий чеклист

- [ ] Установлены зависимости в `frontend/` и `worker/`
- [ ] Выполнен `wrangler login` и `wrangler deploy` в `worker/`
- [ ] Worker задеплоен, URL: `https://alias-api.wadimsergeew190405.workers.dev`
- [ ] В Pages задана переменная `VITE_API_BASE` = этот URL (или в `frontend/.env.production` уже прописан)
- [ ] Сборка фронтенда: `cd frontend && npm run build` (с нужным `VITE_API_BASE`)
- [ ] Деплой фронтенда на Pages (Git или загрузка `frontend/dist`)
- [ ] Проверка создания комнаты и игры через задеплоенный фронт и Worker

После этого проект полностью работает на Cloudflare Pages и Workers.
