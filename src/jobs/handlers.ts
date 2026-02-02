import { boss } from "./boss.js";
import { prisma } from "../db/prisma.js";
import { Bot } from "grammy";

export const JOB_DUE_CHECK = "invoice.due_check";

export async function registerJobHandlers(bot: Bot) {

  await boss.createQueue(JOB_DUE_CHECK);

  await boss.work(JOB_DUE_CHECK, async (job) => {

    const { invoiceId } = job.data as { invoiceId: number };

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { group: true, member: true },
    });
    if (!invoice) return;

    // если уже оплачено/исключение — ничего
    if (invoice.status === "paid" || invoice.status === "excused") return;
    if (invoice.status === "kicked") return;

    // кикаем
    const chatId = invoice.group.tgChatId;
    const userId = Number(invoice.member.tgUserId);

    // "кик без вечного бана": ban + unban
    await bot.api.banChatMember(chatId.toString(), userId);
    await bot.api.unbanChatMember(chatId.toString(), userId);

    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: "kicked" },
    });

    await prisma.auditLog.create({
      data: {
        action: "KICKED_BY_DUE",
        data: { invoiceId: invoice.id, tgChatId: chatId.toString(), tgUserId: userId },
      },
    });
  });
}