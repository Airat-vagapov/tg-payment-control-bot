import { prisma } from "../db/prisma.js";
import { boss } from "../jobs/boss.js";
import { JOB_DUE_CHECK } from "../jobs/handlers.js";
import { computeDueAt, currentPeriod } from "../util/time.js";
import { DateTime } from "luxon";

export async function upsertGroup(params: {
  tgChatId: bigint;
  title: string;
  timezone: string;
  dueDay: number;
  dueHour: number;
  amountCents: number;
}) {
  const { tgChatId, title, timezone, dueDay, dueHour, amountCents } = params;
  return prisma.group.upsert({
    where: { tgChatId },
    update: { title, timezone, dueDay, dueHour, amountCents },
    create: { tgChatId, title, timezone, dueDay, dueHour, amountCents },
  });
}

export async function upsertMember(user: {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}) {
  return prisma.member.upsert({
    where: { tgUserId: BigInt(user.id) },
    update: {
      username: user.username ?? null,
      firstName: user.first_name ?? null,
      lastName: user.last_name ?? null,
    },
    create: {
      tgUserId: BigInt(user.id),
      username: user.username ?? null,
      firstName: user.first_name ?? null,
      lastName: user.last_name ?? null,
    },
  });
}

export async function ensureGroupMember(groupId: number, memberId: number) {
  await prisma.groupMember.upsert({
    where: { groupId_memberId: { groupId, memberId } },
    update: { active: true },
    create: { groupId, memberId, active: true },
  });
}

export async function ensureInvoiceAndSchedule(groupId: number, memberId: number) {
  const group = await prisma.group.findUniqueOrThrow({ where: { id: groupId } });
  const period = currentPeriod(group.timezone);

  const dueAt = computeDueAt(group.timezone, group.dueDay, group.dueHour, period);
  const dueAtJs = dueAt.toJSDate();

  const invoice = await prisma.invoice.upsert({
    where: { groupId_memberId_period: { groupId, memberId, period } },
    update: {},
    create: {
      groupId,
      memberId,
      period,
      amountCents: group.amountCents,
      dueAt: dueAtJs,
      status: "unpaid",
    },
  });

  // ставим job на dueAt (idempotent через singletonKey)
  const singletonKey = `due:${invoice.id}:${invoice.period}`;
  await boss.send(
    "invoice.due_check",
    { invoiceId: invoice.id },
    { startAfter: dueAtJs, singletonKey }
  );

  return { invoice, dueAt: dueAt.toISO() };
}

export async function getInvoiceStatus(groupTgChatId: bigint, tgUserId: bigint) {
  const group = await prisma.group.findUnique({ where: { tgChatId: groupTgChatId } });
  if (!group) return null;

  const period = currentPeriod(group.timezone);
  const member = await prisma.member.findUnique({ where: { tgUserId } });
  if (!member) return null;

  const invoice = await prisma.invoice.findUnique({
    where: { groupId_memberId_period: { groupId: group.id, memberId: member.id, period } },
  });

  return { group, member, period, invoice };
}