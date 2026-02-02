import { Bot, InlineKeyboard } from "grammy";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import { ensureInvoiceAndSchedule, getInvoiceStatus, upsertGroup, upsertMember, ensureGroupMember } from "../services/billings.js";
import { createMockPayment, settleMockPayment } from "../services/payments/mockProvider.js";

export const bot = new Bot(env.BOT_TOKEN);

function guardGroup(chatId: bigint) {
  if (env.ALLOWED_GROUP_CHAT_ID && chatId !== env.ALLOWED_GROUP_CHAT_ID) return false;
  return true;
}

function payKb(invoiceId: number) {
  return new InlineKeyboard()
    .text("💳 Оплатить", `pay:${invoiceId}`)
    .row()
    .text("✅ Тест: отметить оплачено", `mock_paid:${invoiceId}`);
}

bot.command("setup", async (ctx) => {

  if (!ctx.chat || (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")) {
    return ctx.reply("Команда /setup должна быть выполнена в группе.");
  }

  const chatId = BigInt(ctx.chat.id);
  if (!guardGroup(chatId)) return ctx.reply("Эта группа не разрешена для бота.");

  const g = await upsertGroup({
    tgChatId: chatId,
    title: ctx.chat.title ?? "Untitled",
    timezone: env.DEFAULT_TZ,
    dueDay: env.DEFAULT_DUE_DAY,
    dueHour: env.DEFAULT_DUE_HOUR,
    amountCents: env.DEFAULT_AMOUNT_CENTS,
  });

  await ctx.reply(
    `Группа подключена.\nСумма: ${(g.amountCents / 100).toFixed(2)}\nДедлайн: ${g.dueDay} число, ${String(g.dueHour).padStart(2, "0")}:00 (${g.timezone})`
  );
});

bot.on("chat_member", async (ctx) => {
  // ловим вступления
  const upd = ctx.update.chat_member;
  const chat = upd.chat;
  if (!chat || (chat.type !== "group" && chat.type !== "supergroup")) return;

  const chatId = BigInt(chat.id);
  if (!guardGroup(chatId)) return;

  // если пользователь стал member
  if (upd.new_chat_member?.status !== "member") return;

  const group = await prisma.group.findUnique({ where: { tgChatId: chatId } });
  if (!group) return; // группа не настроена

  const member = await upsertMember(upd.new_chat_member.user as any);
  await ensureGroupMember(group.id, member.id);

  // можно сразу создать инвойс на текущий период
  await ensureInvoiceAndSchedule(group.id, member.id);
});

bot.command("pay", async (ctx) => {
  if (!ctx.chat || (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")) {
    return ctx.reply("Команда /pay используется в группе.");
  }
  const chatId = BigInt(ctx.chat.id);
  if (!guardGroup(chatId)) return;

  const group = await prisma.group.findUnique({ where: { tgChatId: chatId } });
  if (!group) return ctx.reply("Группа не настроена. Админ: /setup");

  const member = await upsertMember(ctx.from as any);
  await ensureGroupMember(group.id, member.id);

  const { invoice, dueAt } = await ensureInvoiceAndSchedule(group.id, member.id);

  await ctx.reply(
    `Счёт за период: ${invoice.period}\nСумма: ${(invoice.amountCents / 100).toFixed(2)}\nДедлайн: ${dueAt}\nСтатус: ${invoice.status}`,
    { reply_markup: payKb(invoice.id) }
  );
});

bot.command("status", async (ctx) => {
  if (!ctx.chat || (ctx.chat.type !== "group" && ctx.chat.type !== "supergroup")) {
    return ctx.reply("Команда /status используется в группе.");
  }
  const chatId = BigInt(ctx.chat.id);
  if (!guardGroup(chatId)) return;

  const s = await getInvoiceStatus(chatId, BigInt(ctx.from!.id));
  if (!s) return ctx.reply("Нет данных. Если админ не делал /setup — сначала настройте группу.");

  const inv = s.invoice;
  if (!inv) return ctx.reply(`Период ${s.period}: счёт ещё не создан. Напиши /pay`);

  await ctx.reply(`Период ${s.period}\nСтатус: ${inv.status}\nСумма: ${(inv.amountCents / 100).toFixed(2)}\nДедлайн: ${inv.dueAt.toISOString()}`);
});

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  try {
    if (data.startsWith("pay:")) {
      const invoiceId = Number(data.split(":")[1]);
      const payment = await createMockPayment(invoiceId);

      await ctx.answerCallbackQuery({ text: "Создан тестовый платёж (pending)" });
      await ctx.reply(
        `Платёж создан (mock).\nexternalId: ${payment.externalId}\n\nВ проде тут будет ссылка на оплату.\nПока можно нажать “Тест: отметить оплачено”.`
      );
      return;
    }

    if (data.startsWith("mock_paid:")) {
      const invoiceId = Number(data.split(":")[1]);

      const payment = await prisma.payment.findFirst({
        where: { invoiceId, provider: "mock" },
        orderBy: { createdAt: "desc" },
      });

      // если payment ещё не создавали, создадим
      const p = payment ?? (await createMockPayment(invoiceId));
      await settleMockPayment(p.externalId!);

      await ctx.answerCallbackQuery({ text: "Отмечено как оплачено (mock)" });
      await ctx.reply("✅ Оплата подтверждена (тест).");
      return;
    }

    await ctx.answerCallbackQuery();
  } catch (e) {
    await ctx.answerCallbackQuery({ text: "Ошибка" });
    throw e;
  }
});