import { boss } from "./boss.js";
import { prisma } from "../db/prisma.js";
import { GrammyError, HttpError, Bot } from "grammy";

export const JOB_DUE_CHECK = "invoice.due_check";

type DueCheckJobData = {
  invoiceId: number;
};

function isDueCheckJobData(x: unknown): x is DueCheckJobData {
  return !!x && typeof (x as any).invoiceId === "number";
}

export async function registerJobHandlers(bot: Bot) {

  await boss.createQueue(JOB_DUE_CHECK);

  await boss.work(JOB_DUE_CHECK, async (jobs) => {
    const job = jobs?.[0];

    if (!job || !isDueCheckJobData(job.data)) {
      console.warn("SKIP BAD JOB", {
        job0: job ? { id: job.id, name: job.name, data: job.data } : null,
        jobsLen: Array.isArray(jobs) ? jobs.length : null,
      });
      return;
    }
    const invoiceId = job.data.invoiceId;

    console.log("DUE JOB FIRED", {
      invoiceId,
      now: new Date().toISOString(),
    });

    const invoice = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      include: { group: true, member: true },
    });
    if (!invoice) return;

    // если уже оплачено/исключение — ничего
    if (invoice.status === "paid" || invoice.status === "excused") return;
    if (invoice.status === "kicked") return;

    // кикаем
    console.log("TRY KICK", {
      chatId: invoice.group.tgChatId.toString(),
      userId: Number(invoice.member.tgUserId),
      status: invoice.status,
    });
    const chatId = invoice.group.tgChatId;
    const chatIdStr = chatId.toString();
    const userId = Number(invoice.member.tgUserId);

    // "кик без вечного бана": ban + unban
    try {
      await bot.api.banChatMember(chatIdStr, userId, {
        // Telegram expects `until_date` as Unix time (seconds)
        until_date: Math.floor(Date.now() / 1000) + 60,
      })

      console.log("KICK OK", { chatId, userId });
    } catch (err: any) {
      if (err instanceof GrammyError) {
        console.error("TELEGRAM API ERROR", {
          description: err.description,
          error_code: err.error_code,
          method: err.method,
          payload: err.payload,
        });
      } else if (err instanceof HttpError) {
        console.error("TELEGRAM HTTP ERROR", err);
      } else {
        console.error("UNKNOWN ERROR", err);
      }

      // ВАЖНО: не throw, иначе pg-boss будет ретраить бесконечно
      // Можно записать в audit и завершить job.
      await prisma.auditLog.create({
        data: {
          action: "KICK_FAILED",
          data: { chatId: chatIdStr, userId, invoiceId: invoice.id, err: String(err) },
        },
      });

      return;
    }
    // await bot.api.banChatMember(chatId.toString(), userId);
    // await bot.api.unbanChatMember(chatId.toString(), userId);

    await prisma.invoice.update({
      where: { id: invoice.id },
      data: { status: "kicked" },
    });

    await prisma.auditLog.create({
      data: {
        action: "KICKED_BY_DUE",
        data: { invoiceId: invoice.id, tgChatId: chatIdStr, tgUserId: userId },
      },
    });
  });
}