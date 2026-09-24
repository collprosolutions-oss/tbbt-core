import type { Prisma, PrismaClient } from "@prisma/client";
import type { BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import type { AiConversationArea, CitedFact } from "@/lib/ai/types";

type Db = PrismaClient | Prisma.TransactionClient;

export async function ensureAiConversation(
  db: Db,
  access: BusinessAccess,
  input: { area: AiConversationArea; title: string; conversationId?: string },
) {
  requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
  if (input.conversationId) {
    return access.assertOwned(
      await db.aiConversation.findFirst({
        where: { id: input.conversationId, ...access.scope, area: input.area },
      }),
    );
  }
  return db.aiConversation.create({
    data: {
      businessId: access.businessId,
      membershipId: access.workspace.membership.id,
      area: input.area,
      title: input.title.slice(0, 120),
    },
  });
}

export async function appendConversationMessage(
  db: Db,
  access: BusinessAccess,
  input: {
    conversationId: string;
    role: "USER" | "ASSISTANT" | "SYSTEM";
    content: string;
    stance?: "FACT" | "RECOMMENDATION" | "MIXED";
    citedFacts?: CitedFact[];
    interactionId?: string | null;
  },
) {
  requireBusinessCapability(access, CAPABILITIES.VIEW_REPORTS);
  const conversation = access.assertOwned(
    await db.aiConversation.findFirst({
      where: { id: input.conversationId, ...access.scope },
    }),
  );
  const message = await db.aiConversationMessage.create({
    data: {
      businessId: access.businessId,
      conversationId: conversation.id,
      role: input.role,
      content: input.content,
      stance: input.stance ?? "MIXED",
      citedFacts: input.citedFacts ?? undefined,
      interactionId: input.interactionId ?? null,
    },
  });
  await db.aiConversation.update({
    where: { id: conversation.id },
    data: { updatedAt: new Date() },
  });
  return message;
}

export async function loadCoachConversation(
  db: Db,
  businessId: string,
  membershipId: string,
) {
  return db.aiConversation.findFirst({
    where: { businessId, membershipId, area: "COACH" },
    orderBy: { updatedAt: "desc" },
    include: {
      messages: { orderBy: { createdAt: "asc" }, take: 40 },
    },
  });
}

export async function loadKnowledgeConversation(
  db: Db,
  businessId: string,
  membershipId: string,
) {
  return db.aiConversation.findFirst({
    where: { businessId, membershipId, area: "KNOWLEDGE" },
    orderBy: { updatedAt: "desc" },
    include: {
      messages: { orderBy: { createdAt: "asc" }, take: 40 },
    },
  });
}
