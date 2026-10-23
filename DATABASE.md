# База данных SOCCER24 → Turso

Сайт использует **Turso** (libSQL в облаке).

## Подключение

1. Установите зависимости: `pip install -r requirements.txt`
2. Скопируйте `.env.example` → `.env` и заполните:

```
TURSO_DATABASE_URL=libsql://soccer24-verllasen.aws-eu-north-1.turso.io
TURSO_AUTH_TOKEN=...
```

3. Запуск: `python proxy.py`

Секреты только в `.env` (файл в `.gitignore`).

## Важно

Токен из чата мог быть скомпрометирован — **смените его** в [Turso dashboard](https://turso.tech) и обновите `.env`.
