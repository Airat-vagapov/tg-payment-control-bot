import "dotenv/config";

export const env = {
  BOT_TOKEN: process.env.BOT_TOKEN!,
  DATABASE_URL: process.env.DATABASE_URL!,
  DEFAULT_AMOUNT_CENTS: Number(process.env.DEFAULT_AMOUNT_CENTS ?? 50000),
  DEFAULT_TZ: process.env.DEFAULT_TZ ?? "Europe/Berlin",
  DEFAULT_DUE_DAY: Number(process.env.DEFAULT_DUE_DAY ?? 5),
  DEFAULT_DUE_HOUR: Number(process.env.DEFAULT_DUE_HOUR ?? 18),
  ALLOWED_GROUP_CHAT_ID: process.env.ALLOWED_GROUP_CHAT_ID
    ? BigInt(process.env.ALLOWED_GROUP_CHAT_ID)
    : null,
  WEBHOOK_BASE_URL: process.env.WEBHOOK_BASE_URL ?? null,
};

if (!env.BOT_TOKEN) throw new Error("BOT_TOKEN is required");
if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");

// export default env;