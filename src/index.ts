import Fastify from "fastify";
import { env } from "./config/env.js";
import { bot } from "./bot/bot.js";
import { boss } from "./jobs/boss.js";
import { registerJobHandlers } from "./jobs/handlers.js";

const app = Fastify({ logger: true });

// app.post("/telegram/webhook", async (req, reply) => {
//   // grammY умеет обрабатывать update из webhook
//   await bot.handleUpdate(req.body as any);
//   reply.send({ ok: true });
// });

// webhook эквайринга (пока заглушка)
app.post("/payments/webhook", async (req, reply) => {
  // потом: валидируем подпись провайдера, ищем payment.externalId, ставим paid
  req.log.info({ body: req.body }, "payments webhook received");
  reply.send({ ok: true });
});

app.get("/health", async () => ({ ok: true }));

async function main() {
  await boss.start();

  boss.on("error", (err) => {
    app.log.error({ err }, "pg-boss error");
  });

  await registerJobHandlers(bot);

  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: "0.0.0.0" });

  // Локально можно использовать long polling вместо webhook:
  await bot.start();  // но тогда убери/не используй /telegram/webhook
  //
  // В проде будет webhook: setWebhook на /telegram/webhook
  console.log(`Listening on ${port}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});