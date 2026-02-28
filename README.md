# Telegram Mini App: Визитка разработчика

Структура:

- `frontend` — Notepub-проект (GitHub Pages)
- `backend` — Yandex Cloud Function (Node.js 22) + YDB

## 1) Локальная подготовка

Скопируйте шаблон env и заполните реальными значениями:

```bash
cp .env.example .env
```

Секреты не коммитим.

## 2) Frontend (Notepub)

### Локальная сборка

```bash
cd frontend
../tools/notepub validate --config ./config.yaml --rules ./rules.yaml
../tools/notepub build --config ./config.yaml --rules ./rules.yaml --dist ./dist
```

### Конфиг API для фронтенда

В `frontend/theme/assets/app-config.js` укажите URL HTTP-триггера функции:

```js
window.__NP_TMA_CONFIG__ = {
  apiBase: "https://<api-gateway-domain>.apigw.yandexcloud.net"
};
```

## 3) YDB (новая БД для проекта)

Создайте отдельную serverless БД (в новом ресурсе под проект), затем таблицу:

```sql
-- backend/schema.sql
CREATE TABLE `tma_users` (
  user_id Uint64 NOT NULL,
  username Utf8,
  first_name Utf8,
  last_name Utf8,
  first_seen_at Timestamp NOT NULL,
  last_seen_at Timestamp NOT NULL,
  last_lead_at Timestamp,
  PRIMARY KEY (user_id)
);
```

## 4) Service Account (минимальные права)

Создайте отдельный SA и выдайте минимальные роли на новые ресурсы проекта:

- доступ на запись/чтение в новую YDB
- доступ на выполнение функции (если требуется по вашей схеме)

## 5) Backend deploy (YCF, Node.js 22)

### Установить зависимости

```bash
cd backend
npm ci
```

### Создать новую функцию под проект

```bash
yc serverless function create --name np-tma
```

### Создать бакет для большого пакета функции (один раз)

```bash
yc storage bucket create --name np-tma-artifacts-20260228
```

### Задеплоить код функции

```bash
cd backend
zip -qr function.zip index.js package.json package-lock.json node_modules
SHA=$(shasum -a 256 function.zip | awk '{print $1}')
yc storage s3 cp function.zip s3://np-tma-artifacts-20260228/function.zip

yc serverless function version create \
  --function-name np-tma \
  --runtime nodejs22 \
  --entrypoint index.handler \
  --memory 128m \
  --execution-timeout 5s \
  --package-bucket-name np-tma-artifacts-20260228 \
  --package-object-name function.zip \
  --package-sha256 "$SHA" \
  --service-account-id <new-service-account-id> \
  --environment BOT_TOKEN="<bot-token>",OWNER_CHAT_ID="443746526",ALLOWED_ORIGIN="https://cookiespooky.github.io/np-tma",YDB_ENDPOINT="<ydb-endpoint>",YDB_DATABASE="<ydb-database>",YDB_TABLE="tma_users",AUTH_TTL_SECONDS="3600",LEAD_RATE_LIMIT_SECONDS="300",TELEGRAM_API_BASE="https://api.telegram.org",YDB_METADATA_CREDENTIALS="1"
```

### Дать публичный invoke-доступ функции

```bash
yc serverless function add-access-binding np-tma \
  --role serverless.functions.invoker \
  --subject system:allUsers
```

### Создать API Gateway с маршрутами `/validate` и `/lead`

```bash
yc serverless api-gateway create \
  --name np-tma-gw \
  --spec ./apigw.yaml
```

URL API Gateway используйте как `apiBase` во фронтенде.

## 6) Важный момент по `/lead`

Если Telegram отвечает `Bad Request: chat not found`, значит бот не может писать в `OWNER_CHAT_ID`.
Нужно:

1. Убедиться, что `OWNER_CHAT_ID` верный.
2. Открыть этого бота из owner-аккаунта и нажать `Start`.
3. Повторить `/lead`.

## 7) API contract

### `POST /validate`

Request:

```json
{ "initData": "<telegram initData>" }
```

Success:

```json
{
  "ok": true,
  "user": {
    "id": 123,
    "first_name": "Anton",
    "last_name": "Lozkin",
    "username": "cookiespooky",
    "photo_url": "https://..."
  },
  "stats": {
    "unique_users": 42
  }
}
```

### `POST /lead`

Request:

```json
{ "initData": "<telegram initData>" }
```

Success:

```json
{ "ok": true }
```

Rate limit: не чаще 1 раза в 5 минут на `user_id`.

## 8) Error codes

- `MISSING_INITDATA`
- `INVALID_INITDATA`
- `EXPIRED_INITDATA`
- `RATE_LIMITED`
- `INTERNAL_ERROR`

## 9) Безопасные логи

Логируются только:

- `event_type` (`validate_ok`, `validate_fail`, `lead_ok`, `lead_fail`)
- `user_id`
- `timestamp`

Без `initData`, без `hash`, без query string.
