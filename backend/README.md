# Alias Web (MVP)

## Запуск бэкенда (FastAPI)

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
.\run.ps1
```

Бэкенд будет доступен на `http://localhost:8000`.
Если в логе видите `http://0.0.0.0:8000` — это адрес привязки. В браузере открывайте `http://localhost:8000/docs`.

## API (кратко)

- `POST /api/teams` → создать команду, возвращает код
- `POST /api/join` → войти в команду по коду, возвращает `player_id`
- `WS /ws` → realtime (первым сообщением отправьте `{type:"hello", player_id:"..."}`)

