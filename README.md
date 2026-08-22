# VOLT — бекенд реєстрації з реальними SMS (Twilio Verify)

Цей сервер робить дві речі:
1. Надсилає справжній SMS-код на телефон через **Twilio Verify**.
2. Перевіряє код і видає користувачу сесійний токен (JWT), а акаунт зберігає
   в справжній базі даних (SQLite-файл `volt.db` поруч із проєктом) —
   назавжди, а не в `localStorage` браузера.

---

## Крок 1. Заведіть акаунт Twilio і Verify Service

1. Зареєструйтесь на **https://www.twilio.com/try-twilio** (є безкоштовний trial-баланс).
2. У Twilio Console (https://console.twilio.com) на головній сторінці скопіюйте:
   - **Account SID**
   - **Auth Token**
3. Перейдіть у **Verify → Services → Create new Service**, назвіть його,
   наприклад, `VOLT`. Скопіюйте **Service SID** (починається на `VA...`).
4. ⚠️ **Trial-акаунт Twilio може надсилати SMS тільки на номери, які ви
   заздалегідь підтвердили** в Console → Phone Numbers → Verified Caller IDs.
   Щоб надсилати будь-кому (включно з реальними користувачами з Ізраїлю),
   потрібно поповнити баланс і перевести акаунт у статус paid — це займає
   кілька хвилин у Console.

## Крок 2. Локальний запуск

```bash
cd volt-backend
npm install
cp .env.example .env
```

Відкрийте `.env` і вставте свої `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`,
`TWILIO_VERIFY_SERVICE_SID`. Згенеруйте `JWT_SECRET`:

```bash
openssl rand -hex 32
```

Запустіть сервер:

```bash
npm start
```

Побачите:
```
⚡ VOLT auth backend running on http://localhost:3000
```

## Крок 3. Перевірте endpoint-и вручну (curl)

```bash
# 1. Надіслати код
curl -X POST http://localhost:3000/api/auth/send-code \
  -H "Content-Type: application/json" \
  -d '{"phone":"+972501234567"}'

# 2. Перевірити код, який реально прийшов на телефон
curl -X POST http://localhost:3000/api/auth/verify-code \
  -H "Content-Type: application/json" \
  -d '{"phone":"+972501234567","code":"123456"}'
# → поверне { "token": "...", "user": {...} }

# 3. Перевірити токен
curl http://localhost:3000/api/me -H "Authorization: Bearer <token>"
```

## Крок 4. Підключіть фронтенд (volt-messenger.html)

У файлі `volt-messenger.html` вгорі скрипта є змінна:

```js
const API_BASE_URL = ''; // ← встановіть тут адресу вашого бекенду
```

Поки вона порожня — застосунок працює в демо-режимі (код показується в
жовтому банері). Щойно ви впишете туди адресу (спершу
`http://localhost:3000`, а після деплою — вашу production-адресу),
застосунок автоматично почне надсилати справжні SMS через цей сервер.

## Крок 5. Найпростіший деплой — Replit (без терміналу, без CLI)

Фронтенд (`volt-messenger.html`) можна залити на **Netlify** перетягуванням
файлу на app.netlify.com — секунда, без жодних налаштувань.

Бекенд — це процес, що працює постійно (сервер + WebSocket + база), тому
Netlify його не запустить. Найпростіший спосіб без терміналу й без CLI —
**Replit**:

1. **replit.com** → зареєструйтесь → **"+ Create Repl"** → шаблон **Node.js**.
2. Зліва в панелі файлів завантажте вміст цієї папки (`package.json`, `src/`,
   `README.md`) кнопкою **"Upload folder"**.
3. Зліва іконка ключа → **"Secrets"** → додайте кожну змінну як окремий
   рядок (ключ/значення), ті самі, що й у `.env.example`.
4. Натисніть зелену кнопку **"Run"** вгорі — Replit сам поставить пакети й
   запустить сервер.
5. Праворуч з'явиться публічне посилання (`https://ваш-repl.username.repl.co`)
   — це і є `API_BASE_URL` для фронтенду.

⚠️ На безкоштовному тарифі Replit сервер "засинає" після тривалої
бездіяльності й прокидається при першому запиті (перше повідомлення після
паузи може прийти з невеликою затримкою) — для стабільної 24/7 роботи з
реальними користувачами варто перейти на платний "Always On".

### Альтернатива — Railway CLI (термінал)

Якщо не проти терміналу — Railway трохи надійніше для 24/7:

```bash
cd volt-backend
npm install -g @railway/cli
railway login                 # відкриє браузер на секунду, підтвердити вхід
railway init                  # створює проєкт і прив'язує цю папку
railway variables --set "TWILIO_ACCOUNT_SID=ACxxxxxxxx"
railway variables --set "TWILIO_AUTH_TOKEN=xxxxxxxx"
railway variables --set "TWILIO_VERIFY_SERVICE_SID=VAxxxxxxxx"
railway variables --set "JWT_SECRET=$(openssl rand -hex 32)"
railway variables --set "CORS_ORIGIN=https://ВАШ-САЙТ.netlify.app"
railway up                    # деплой
railway domain                # видасть публічну адресу сервера
```

Отриману адресу (напр. `https://volt-backend-production.up.railway.app`)
впишіть в `API_BASE_URL` у `volt-messenger.html`, і перезалийте цей файл на
Netlify (перетягніть ще раз — Netlify не бачить змін сам).

**Альтернатива через веб-консоль (Railway/Render):**
1. `railway.app` або `render.com` → New Project → Deploy from GitHub repo
   (спершу залийте цю папку у свій GitHub-репозиторій).
2. У Settings → Variables додайте ті самі змінні, що й у `.env`.
3. Отримаєте публічний URL на кшталт `https://volt-backend.up.railway.app`.

⚠️ Важливо: `volt.db` (SQLite-файл) на безкоштовних тарифах Railway/Render
може стиратись при кожному передеплої (файлова система ефемерна). Для
продакшну з реальними користувачами перейдіть на **Postgres** (Railway й
Render дають безкоштовну Postgres-базу в один клік) — доведеться переписати
лише `src/db.js`, решта коду не зміниться.

## Реальний чат і дзвінки (Socket.io)

Після запуску сервера (`npm start`) той самий процес обслуговує і REST, і
WebSocket-з'єднання на тому ж порту.

**REST для розмов:**
```bash
# Почати/відкрити чат з іншим зареєстрованим користувачем за його номером
curl -X POST http://localhost:3000/api/conversations/direct \
  -H "Content-Type: application/json" -H "Authorization: Bearer <token>" \
  -d '{"phone":"+972501234568"}'

# Список моїх чатів
curl http://localhost:3000/api/conversations -H "Authorization: Bearer <token>"

# Історія повідомлень одного чату
curl http://localhost:3000/api/conversations/<conversationId>/messages \
  -H "Authorization: Bearer <token>"
```

**Живий обмін повідомленнями та дзвінки** йдуть через Socket.io
(`io(API_BASE_URL, { auth: { token } })`) — це вже підключено у
`volt-messenger.html`, окремо нічого писати не треба. Достатньо, щоб
обидва користувачі мали акаунти (зареєструвались через `/api/auth/*`) і
знали номер телефону одне одного.

## Push-сповіщення (щоб спливали на екрані блокування, навіть коли VOLT закритий)

Це працює через **Firebase Cloud Messaging** — безкоштовно, той самий механізм,
яким користуються WhatsApp/Telegram для Android-сповіщень.

**1. Заведіть Firebase-проєкт** (з телефону, через firebase.google.com):
- New Project → назвіть, напр. `volt-messenger` → створити.
- Project Settings (⚙️) → General → "Your apps" → Web (`</>`) → зареєструйте
  веб-застосунок → скопіюйте `apiKey`, `authDomain`, `projectId`,
  `messagingSenderId`, `appId`.
- Project Settings → Cloud Messaging → Web Push certificates → Generate key pair
  → це `FIREBASE_VAPID_KEY`.
- Project Settings → Service Accounts → Generate new private key → завантажить
  JSON-файл із `project_id`, `client_email`, `private_key` — це для бекенду.

**2. На бекенді** — впишіть у `.env`:
```
FIREBASE_PROJECT_ID=...
FIREBASE_CLIENT_EMAIL=...
FIREBASE_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

**3. На фронтенді** (`index.html` і `sw.js` у пакеті застосунку) — впишіть
той самий публічний `FIREBASE_CONFIG` (apiKey/authDomain/projectId/...) у
**обидва** файли (вони мають збігатися), і `FIREBASE_VAPID_KEY` в `index.html`.

Без цих кроків усе інше (чат, дзвінки) продовжує працювати як і раніше —
push просто не спрацює, поки застосунок повністю закритий.

- **Дзвінки** вже частково є: сервер ретранслює WebRTC-сигналінг
  (`call:invite`/`call:answer`/`call:ice-candidate`) через ті самі
  Socket.io-з'єднання. У `volt-messenger.html` це підключено — дзвінки
  працюють через безкоштовні публічні STUN/TURN (Google STUN + Open Relay
  Project), без реєстрації. Для великого навантаження варто підняти власний
  TURN (coturn) — публічні TURN не гарантують стабільність.
- Реальний E2EE (Signal Protocol) — зараз повідомлення шифруються лише в
  транспорті (HTTPS/WSS), але зберігаються на сервері у відкритому вигляді.
