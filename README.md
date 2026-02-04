# tg-payment-control-bot

Telegram-бот для контроля ежемесячных платежей в группе: выставляет счет участнику в личке с ботом, отслеживает статус оплаты и запускает проверку в дедлайн через очередь задач.

## Что умеет сейчас

- `/setup` — подключает группу и сохраняет базовые настройки (сумма, TZ, дедлайн).
- `/groups` — в личке показывает список групп и выбирает активную группу.
- `/pay` — в личке создает/находит счет за текущий период и показывает кнопки оплаты.
- `/status` — в личке показывает статус счета текущего пользователя.
- Mock-платежи для локальной отладки (`pending` -> `paid`).
- Отложенная due-check job через `pg-boss` на конкретный `dueAt`.

## Стек

- Node.js + TypeScript
- Telegram Bot API через `grammy`
- PostgreSQL + Prisma
- Фоновые задачи: `pg-boss`
- HTTP-сервер: `fastify`
- Время и TZ: `luxon`

## Структура проекта

```text
src/
  index.ts                    # запуск API, бота и job-воркеров
  bot/
    bot.ts                    # команды и callback-обработчики Telegram
  services/
    billings.ts               # core-логика счетов/периодов/постановки job
    payments/mockProvider.ts  # mock-платежи
  jobs/
    boss.ts                   # конфиг pg-boss
    handlers.ts               # обработчик invoice.due_check
  db/
    prisma.ts                 # Prisma client
  config/
    env.ts                    # переменные окружения
  util/
    time.ts                   # период и дедлайн

prisma/schema.prisma          # схема БД
docker-compose.yml            # локальный PostgreSQL
```

## Быстрый старт

1. Установить зависимости:

```bash
npm install
```

2. Поднять PostgreSQL:

```bash
docker compose up -d db
```

3. Создать `.env` (минимум):

```env
BOT_TOKEN=your_telegram_bot_token
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/tgpay
```

4. Применить схему:

```bash
npm run prisma:push
```

5. Запустить проект:

```bash
npm run dev
```

## Переменные окружения

Обязательные:
- `BOT_TOKEN`
- `DATABASE_URL`

Опциональные (с дефолтами в `src/config/env.ts`):
- `PORT=3000`
- `DEFAULT_AMOUNT_CENTS=50000`
- `DEFAULT_TZ=Europe/Berlin`
- `DEFAULT_DUE_DAY=5`
- `DEFAULT_DUE_HOUR=18`
- `ALLOWED_GROUP_CHAT_ID` (ограничить работу бота только на 1 группу)
- `WEBHOOK_BASE_URL` (под будущий webhook-сценарий)
- `TEST_DUE_IN_MINUTES` (ускоренный дедлайн для теста)

## Основной сценарий работы

1. Админ в группе вызывает `/setup`.
2. Участник открывает личку с ботом, делает `/groups` и выбирает группу.
3. Участник делает `/pay` в личке.
4. `billings.ensureInvoiceAndSchedule`:
   - определяет период (`YYYY-MM`) в TZ группы,
   - создаёт/находит invoice через `upsert`,
   - ставит due-check job в `pg-boss` на `dueAt`.
5. При оплате mock-провайдер переводит invoice в `paid`.
6. В момент дедлайна job:
   - если `paid`/`excused` — ничего не делает,
   - иначе применяет санкцию (`kicked`) и пишет аудит.

## Команды

- `npm run dev` — запуск в режиме разработки
- `npm run build` — сборка TypeScript в `dist/`
- `npm run start` — запуск production-сборки
- `npm run prisma:push` — применить схему Prisma
- `npm run prisma:studio` — открыть Prisma Studio

## Документация для пользователя

- `USER_GUIDE.md` — подробное руководство пользователя
- `USER_GUIDE.pdf` — PDF-версия руководства

## Ограничения текущей версии

- Реальный платежный провайдер пока не подключен (только mock).
- `/payments/webhook` пока заглушка.
- Сейчас используется long polling (`bot.start()`), webhook-путь оставлен как заготовка.
