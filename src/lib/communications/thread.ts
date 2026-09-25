import { Prisma, type PrismaClient } from "@prisma/client";
import { ensureCommunicationsSchema } from "@/lib/communications/schema";

type Db = PrismaClient | Prisma.TransactionClient;

export async function getOrCreateCustomerThread(
  db: Db,
  input: {
    businessId: string;
    customerId: string;
    title?: string | null;
  },
) {
  await ensureCommunicationsSchema(db);
  const customer = await db.customer.findFirst({
    where: { id: input.customerId, businessId: input.businessId },
    select: { id: true, name: true },
  });
  if (!customer) return null;

  const existing = await db.communicationThread.findFirst({
    where: {
      businessId: input.businessId,
      customerId: customer.id,
      subjectType: "CUSTOMER",
      subjectId: customer.id,
    },
  });
  if (existing) return existing;

  try {
    return await db.communicationThread.create({
      data: {
        businessId: input.businessId,
        customerId: customer.id,
        subjectType: "CUSTOMER",
        subjectId: customer.id,
        title: input.title ?? customer.name,
        lastActivityAt: new Date(),
      },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      return db.communicationThread.findFirst({
        where: {
          businessId: input.businessId,
          customerId: customer.id,
          subjectType: "CUSTOMER",
          subjectId: customer.id,
        },
      });
    }
    throw error;
  }
}

export async function touchCommunicationThread(
  db: Db,
  input: { businessId: string; threadId: string; at?: Date },
) {
  await db.communicationThread.updateMany({
    where: { id: input.threadId, businessId: input.businessId },
    data: { lastActivityAt: input.at ?? new Date() },
  });
}
