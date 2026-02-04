import { Bot, InlineKeyboard } from "grammy";
import { env } from "../config/env.js";
import { prisma } from "../db/prisma.js";
import {
  ensureInvoiceAndSchedule,
  getInvoiceStatusByGroupId,
  listMemberGroups,
  setSelectedGroupForMember,
  upsertGroup,
  upsertMember,
  ensureGroupMember,
} from "../services/billings.js";
import { createMockPayment, settleMockPayment } from "../services/payments/mockProvider.js";
import { currentPeriod } from "../util/time.js";

export const bot = new Bot(env.BOT_TOKEN);

function guardGroup(chatId: bigint) {
  if (env.ALLOWED_GROUP_CHAT_ID && chatId !== env.ALLOWED_GROUP_CHAT_ID) return false;
  return true;
}

function isGroupChat(chatType?: string) {
  return chatType === "group" || chatType === "supergroup";
}

function groupsKb(
  groups: Array<{ id: number; title: string; tgChatId: bigint }>,
  selectedGroupId?: number | null
) {
  const kb = new InlineKeyboard();
  for (const group of groups) {
    const title = selectedGroupId === group.id ? `✅ ${group.title}` : group.title;
    kb.text(title, `select_group:${group.id}`).row();
  }
  return kb;
}

function payKb(invoiceId: number) {
  return new InlineKeyboard()
    .text("💳 Оплатить", `pay:${invoiceId}`)
    .row()
    .text("✅ Тест: отметить оплачено", `mock_paid:${invoiceId}`);
}

async function resolveSelectedGroupOrReply(ctx: any) {
  if (!ctx.chat || ctx.chat.type !== "private") {
    await ctx.reply("Эта команда работает только в личном чате с ботом.");
    return null;
  }

  const member = await upsertMember(ctx.from as any);
  const data = await listMemberGroups(BigInt(ctx.from.id));
  if (!data || data.groups.length === 0) {
    await ctx.reply(
      "Ты пока не привязан ни к одной группе. Сначала добавь бота в группу и сделай /setup."
    );
    return null;
  }

  let selectedGroup =
    data.selectedGroupId != null ? data.groups.find((g) => g.id === data.selectedGroupId) : undefined;

  if (!selectedGroup && data.groups.length === 1) {
    await setSelectedGroupForMember({ tgUserId: BigInt(ctx.from.id), groupId: data.groups[0].id });
    selectedGroup = data.groups[0];
  }

  if (!selectedGroup) {
    await ctx.reply(
      "Выбери группу командой /groups, затем повтори команду."
    );
    return null;
  }

  return { member, group: selectedGroup };
}

bot.command("start", async (ctx) => {
  if (!ctx.chat || ctx.chat.type !== "private") {
    return ctx.reply("Напиши мне в личку, чтобы оплачивать и смотреть статус.");
  }
  await upsertMember(ctx.from as any);
  await ctx.reply(
    "Привет! Здесь можно работать с оплатой.\n\n1) /groups — выбрать группу\n2) /pay — получить счёт\n3) /status — проверить статус"
  );
});

bot.command("setup", async (ctx) => {
  if (!ctx.chat || !isGroupChat(ctx.chat.type)) {
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
  if (!chat || !isGroupChat(chat.type)) return;

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
  if (!ctx.chat || ctx.chat.type !== "private") {
    return ctx.reply("Команда /pay работает в личке с ботом.");
  }
  const selected = await resolveSelectedGroupOrReply(ctx);
  if (!selected) return;
  const { group, member } = selected;

  const period = currentPeriod(group.timezone);

  const paid = await prisma.invoice.findFirst({
    where: {
      groupId: group.id,
      memberId: member.id,
      period,
      status: "paid",
    },
    select: { id: true, period: true, paidAt: true },
  });

  if (paid) {
    return ctx.reply(
      `Этот период уже оплачен: ${paid.period}${paid.paidAt ? `\nДата оплаты: ${paid.paidAt.toISOString()}` : ""}`
    );
  }

  const { invoice, dueAt } = await ensureInvoiceAndSchedule(group.id, member.id);

  await ctx.reply(
    `Группа: ${group.title}\nСчёт за период: ${invoice.period}\nСумма: ${(invoice.amountCents / 100).toFixed(2)}\nДедлайн: ${dueAt}\nСтатус: ${invoice.status}`,
    { reply_markup: payKb(invoice.id) }
  );
});

bot.command("groups", async (ctx) => {
  if (!ctx.chat || ctx.chat.type !== "private") {
    return ctx.reply("Команда /groups работает в личке с ботом.");
  }

  await upsertMember(ctx.from as any);
  const data = await listMemberGroups(BigInt(ctx.from.id));
  if (!data || data.groups.length === 0) {
    return ctx.reply(
      "Нет доступных групп. Добавь бота в группу и сделай /setup."
    );
  }

  const selectedGroup =
    data.selectedGroupId != null ? data.groups.find((g) => g.id === data.selectedGroupId) : undefined;
  await ctx.reply(
    `Твои группы:\n${data.groups.map((g, i) => `${i + 1}. ${g.title}`).join("\n")}\n\nТекущая: ${selectedGroup ? selectedGroup.title : "не выбрана"}`,
    { reply_markup: groupsKb(data.groups, data.selectedGroupId) }
  );
});

bot.command("status", async (ctx) => {
  if (!ctx.chat || ctx.chat.type !== "private") {
    return ctx.reply("Команда /status работает в личке с ботом.");
  }
  const selected = await resolveSelectedGroupOrReply(ctx);
  if (!selected) return;

  const s = await getInvoiceStatusByGroupId(selected.group.id, BigInt(ctx.from!.id));
  if (!s) return ctx.reply("Нет данных по выбранной группе.");

  const inv = s.invoice;
  if (!inv) return ctx.reply(`Период ${s.period}: счёт ещё не создан. Напиши /pay`);

  await ctx.reply(
    `Группа: ${s.group.title}\nНомер счета: ${inv.id}\nПериод ${s.period}\nСтатус: ${inv.status}\nСумма: ${(inv.amountCents / 100).toFixed(2)}\nДедлайн: ${inv.dueAt.toISOString()}`
  );
});

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  try {
    if (data.startsWith("select_group:")) {
      if (!ctx.chat || ctx.chat.type !== "private") {
        await ctx.answerCallbackQuery({ text: "Выбор группы только в личке" });
        return;
      }
      const groupId = Number(data.split(":")[1]);
      const updated = await setSelectedGroupForMember({ tgUserId: BigInt(ctx.from.id), groupId });
      if (!updated || !updated.selectedGroup) {
        await ctx.answerCallbackQuery({ text: "Группа недоступна" });
        return;
      }

      const info = await listMemberGroups(BigInt(ctx.from.id));
      if (info) {
        await ctx.editMessageReplyMarkup({
          reply_markup: groupsKb(info.groups, updated.selectedGroupId),
        });
      }
      await ctx.answerCallbackQuery({ text: `Выбрано: ${updated.selectedGroup.title}` });
      await ctx.reply(`Текущая группа: ${updated.selectedGroup.title}`);
      return;
    }

    if (data.startsWith("pay:")) {
      if (!ctx.chat || ctx.chat.type !== "private") {
        await ctx.answerCallbackQuery({ text: "Оплата только в личке с ботом" });
        return;
      }
      const invoiceId = Number(data.split(":")[1]);
      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { member: true },
      });
      if (!invoice) {
        await ctx.answerCallbackQuery({ text: "Счёт не найден" });
        return;
      }
      if (invoice.member.tgUserId !== BigInt(ctx.from.id)) {
        await ctx.answerCallbackQuery({ text: "Это не твой счёт" });
        return;
      }

      const payment = await createMockPayment(invoiceId);

      await ctx.answerCallbackQuery({ text: "Создан тестовый платёж (pending)" });
      await ctx.reply(
        `Платёж создан (mock).\nexternalId: ${payment.externalId}\n\nВ проде тут будет ссылка на оплату.\nПока можно нажать “Тест: отметить оплачено”.`
      );
      return;
    }

    if (data.startsWith("mock_paid:")) {
      if (!ctx.chat || ctx.chat.type !== "private") {
        await ctx.answerCallbackQuery({ text: "Оплата только в личке с ботом" });
        return;
      }
      const invoiceId = Number(data.split(":")[1]);
      const invoice = await prisma.invoice.findUnique({
        where: { id: invoiceId },
        include: { member: true },
      });
      if (!invoice) {
        await ctx.answerCallbackQuery({ text: "Счёт не найден" });
        return;
      }
      if (invoice.member.tgUserId !== BigInt(ctx.from.id)) {
        await ctx.answerCallbackQuery({ text: "Это не твой счёт" });
        return;
      }

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
