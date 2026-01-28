import { prisma } from "../../db/prisma.js";

export async function createMockPayment(invoiceId: number) {
  const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: invoiceId } });

  // создаём payment как "pending"
  const payment = await prisma.payment.create({
    data: {
      invoiceId,
      provider: "mock",
      externalId: `mock_${invoiceId}_${Date.now()}`,
      amountCents: invoice.amountCents,
      status: "pending",
    },
  });

  await prisma.invoice.update({
    where: { id: invoiceId },
    data: { status: "pending" },
  });

  return payment;
}

export async function settleMockPayment(externalId: string) {
  const payment = await prisma.payment.findUniqueOrThrow({ where: { externalId } });

  await prisma.payment.update({
    where: { id: payment.id },
    data: { status: "succeeded" },
  });

  await prisma.invoice.update({
    where: { id: payment.invoiceId },
    data: { status: "paid", paidAt: new Date() },
  });

  return payment;
}