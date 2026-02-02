# Деплой Alias Web на Cloudflare Pages и Workers

Проект состоит из двух частей:

- **Фронтенд** — то, что открывается в браузере (интерфейс игры). Собирается из папки `frontend/` в репозитории и раздаётся через **Cloudflare Pages**.
- **Бэкенд** (API и WebSocket) — уже задеплоен как **Cloudflare Worker**. Его URL: `https://alias-api.wadimsergeew190405.workers.dev`.

Если вы уже залили проект на GitHub и задеплоили Worker — переходите к разделу **«Деплой фронтенда (проект на GitHub)»** ниже.

---

## Деплой фронтенда (проект на GitHub)

Здесь мы подключаем ваш GitHub-репозиторий к Cloudflare Pages. Cloudflare будет сам собирать фронтенд из папки `frontend/` и публиковать сайт.

### Шаг 1. Откройте Cloudflare Dashboard

1. Зайдите на [dash.cloudflare.com](https://dash.cloudflare.com) и войдите в аккаунт (тот же, в котором задеплоен Worker).
2. В левом меню выберите **Workers & Pages**.

### Шаг 2. Создайте проект Pages и подключите GitHub

1. Нажмите **Create** → **Pages**.
2. Выберите **Connect to Git** (подключить репозиторий).
3. Если GitHub ещё не подключён:
   - Нажмите **Connect GitHub** и разрешите доступ к репозиториям (можно только выбранному репо).
   - Выберите организацию/аккаунт и репозиторий с проектом Alias.
4. Нажмите **Begin setup** у нужного репозитория.

### Шаг 3. Настройте сборку

На экране **Set up builds and deployments** укажите:

| Поле | Значение |
|------|----------|
| **Project name** | Любое имя, например `alias-web` (по нему будет URL: `alias-web.pages.dev`). |
| **Production branch** | Оставьте `main` (или ветку, куда вы пушите код). |
| **Root directory** | Оставьте **`/`** (корень репозитория). |
| **Framework preset** | **None** (не Vite, не React — свой проект). |
| **Build command** | `cd frontend && npm ci && npm run build` |
| **Deploy command** (если поле обязательное) | `true` |

**Обязательно** найдите и заполните поле с путём к результату сборки — иначе на сайте будет «Hello world» или пустая страница. Оно может называться **Build output directory**, **Output directory**, **Publish directory** или **Build directory**. Укажите там **`frontend/dist`** (путь от корня репозитория к папке со сборкой). Обычно оно в **Settings** → **Builds & deployments** (иногда внутри блока **Build configuration** или **Build settings**).

**Команда деплоя (Deploy command):** если поле обязательное (Required), укажите **`true`** (без кавычек). Worker деплоится отдельно с вашего компьютера из папки `worker/`; Pages сам загружает результат сборки как сайт.

Важно: при **Root directory** = `/` сборка идёт из корня репозитория, поэтому в Build command сначала заходим в `frontend` (`cd frontend`), затем ставим зависимости и собираем. Результат — папка `frontend/dist`.

Нажмите **Save and Deploy**. Первая сборка запустится. Она может завершиться с ошибкой, если не задана переменная окружения — это исправим на следующем шаге.

### Шаг 4. Добавьте переменную окружения (URL бэкенда)

Фронтенду нужно знать адрес Worker (API и WebSocket). Без этого запросы уйдут не туда и игра не заработает.

1. В проекте Pages откройте вкладку **Settings**.
2. Слева выберите **Environment variables**.
3. Нажмите **Add variable** (или **Add**).
4. Укажите:
   - **Variable name:** `VITE_API_BASE`
   - **Value:** `https://alias-api.wadimsergeew190405.workers.dev`  
     (без слеша в конце, без пробелов)
5. Область: отметьте **Production** (и при желании **Preview**).
6. Сохраните (**Save**).

### Шаг 5. Пересоберите проект

После добавления переменной нужно перезапустить сборку, чтобы она подхватила `VITE_API_BASE`:

1. Откройте вкладку **Deployments**.
2. У последнего деплоя нажмите **⋯** (три точки) → **Retry deployment** (или **Create deployment** → **Retry**).

Дождитесь зелёного статуса **Success**. Над списком деплоев будет ссылка вида **https://alias-web.pages.dev** (или как вы назвали проект) — это и есть ваш сайт.

### Шаг 6. Проверка

1. Откройте ссылку на сайт (например `https://alias-web.pages.dev`).
2. Создайте комнату, зайдите в неё, создайте команду и присоединитесь.
3. Убедитесь, что игра работает: слова, раунды, очки обновляются. Откройте ту же комнату в другой вкладке или на телефоне — состояние должно совпадать (данные идут через Worker).

Если что-то не работает:

- В **Settings** → **Environment variables** проверьте, что `VITE_API_BASE` задан без опечаток и без слеша в конце.
- В браузере откройте DevTools (F12) → вкладка **Network**. Обновите страницу и создайте комнату: запросы должны уходить на `https://alias-api.wadimsergeew190405.workers.dev/api/...` и `wss://alias-api.../ws`. Если запросы идут на другой адрес или падают с CORS — вернитесь к шагу 4.

**Ошибка «root directory not found»:** в поле **Root directory** указано `frontend/dist`. Нужна папка с исходниками, а не со сборкой: укажите **`frontend`** (без `/dist`). Папка `dist` создаётся при сборке. Если есть поле **Build output directory** — укажите там **`dist`**.

**Ошибка «Missing entry-point to Worker script» при сборке Pages:** в поле **Deploy command** указано `npx wrangler deploy`. Замените на **`true`** (без кавычек) или очистите поле, если оно не обязательное. Сохраните и сделайте **Retry deployment**.

**На Worker (alias-api….workers.dev) открываю в браузере — «Not Found»:** это нормально. Worker обрабатывает только пути `/api/*` и `/ws`. Главная страница (`/`) не отдаётся — на ней 404. Фронтенд должен обращаться к этому URL за API и WebSocket (переменная `VITE_API_BASE`), а не открывать его как сайт в браузере.

**На сайте показывается «Hello world»:** Pages публикует не папку со сборкой, а корень репозитория или заглушку. Что сделать:
1. **Settings** → **Builds & deployments** → найдите поле **Build output directory** (или **Output directory**, **Publish directory**, **Build directory**) и укажите **`frontend/dist`**. Сохраните и сделайте **Retry deployment**.
2. Если такого поля нет: попробуйте **Framework preset** = **Vite**, **Root directory** = **`frontend`**, **Build command** = **`npm ci && npm run build`**. У пресета Vite обычно подставляется вывод в `dist`; тогда сайт будет браться из `frontend/dist`. Сохраните и пересоберите проект.

---

## Кратко: что уже есть и что вы сделали

| Часть | Где живёт | Что вы сделали |
|-------|-----------|----------------|
| **Бэкенд (API + WebSocket)** | Cloudflare Worker | Уже задеплоен, URL: `https://alias-api.wadimsergeew190405.workers.dev` |
| **Фронтенд (сайт)** | Cloudflare Pages | Подключили GitHub, настроили сборку из `frontend/`, добавили `VITE_API_BASE`, задеплоили. Сайт открывается по ссылке вида `https://<имя-проекта>.pages.dev`. |

Дальше: пушите изменения в GitHub — Cloudflare сам пересоберёт и обновит сайт при каждом пуше в выбранную ветку (обычно `main`).

---

## Если Worker ещё не задеплоен

Сначала задеплойте бэкенд (один раз):

```powershell
cd worker
npm install
npx wrangler login
npx wrangler deploy
```

В консоли появится URL Worker (например `https://alias-api.wadimsergeew190405.workers.dev`). Этот же URL укажите в переменной `VITE_API_BASE` в Pages (шаг 4 выше). Если URL у вас другой — подставьте его в **Value** при добавлении переменной.

---

## Дополнительно

- **Свой домен:** в проекте Pages откройте **Custom domains**, добавьте домен и следуйте подсказкам Cloudflare.
- **Локальная разработка:** `cd frontend && npm run dev` — фронт подключается к `http://localhost:8000` (нужен запущенный Python-бэкенд) или задайте `VITE_API_BASE` для теста против Worker.
- **Один домен для сайта и API:** можно повесить и Pages, и Worker на один домен (разные пути). Это настраивается в Dashboard (Custom domains, Routes) — при необходимости можно расписать отдельно.

После выполнения шагов 1–6 проект полностью работает: фронт на Pages, бэкенд на Worker, репозиторий на GitHub.
