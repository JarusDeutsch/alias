# Alias Web

## Запуск (локально)

### Бэкенд (FastAPI)

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
.\run.ps1
```

Важно: в логе Uvicorn может писать `http://0.0.0.0:8000` — это адрес привязки. В браузере открывайте **`http://localhost:8000/docs`** (или `http://127.0.0.1:8000/docs`).

### Фронтенд (Vite)

```powershell
cd frontend
npm install
npm run dev
```

Откройте адрес из вывода `npm run dev` (обычно `http://localhost:5173`, но если порт занят — будет `http://localhost:5174` и т.д.).

## Деплой на Cloudflare Pages и Workers

Фронтенд можно раздавать через **Cloudflare Pages**, бэкенд — через **Cloudflare Worker** с Durable Object (API и WebSocket). Подробная пошаговая инструкция: **[DEPLOY.md](DEPLOY.md)**.

## Правило видимости слов

- **Загадывающий** видит `current_word`.
- **Угадывающие** **не видят** `current_word` и получают слово только как `last_revealed_word` **после** нажатия загадывающим «Следующее слово».

