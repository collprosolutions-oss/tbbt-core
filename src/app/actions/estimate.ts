"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { requireBusinessAccess, type BusinessAccess } from "@/lib/access";
import { CAPABILITIES, requireBusinessCapability } from "@/lib/authorization";
import {
  buildEstimateReadyEmail,
  formatEstimateServiceAddress,
} from "@/lib/estimate-mail";
import { createEstimateVersionSnapshot } from "@/lib/estimate-version";
import { persistDraftEstimateTotal } from "@/lib/labor-minimum";
import {
  addCatalogItemToDraftEstimate,
  applyDraftEstimateCalculator,
  estimateLineErrorMessage,
  overrideDraftEstimateLinePrice,
  persistDraftEstimateCalculatorRates,
  priceDraftEstimateLine,
  saveDraftEstimateLineAsCatalog,
  updateDraftEstimateLineIncludedWork,
} from "@/lib/estimate-line-ops";
import { joinLineDescription } from "@/lib/estimate-line-scope";
import {
  convertDraftMaterialTakeoff,
  isTakeoffTypeId,
  parseTakeoffFormSnapshot,
  recalculateDraftMaterialTakeoff,
  saveDraftMaterialTakeoff,
} from "@/lib/material-takeoff";
import { parseWorkAreaIntake } from "@/lib/work-area-intake";
import { toStoredIntakeMeasurement } from "@/lib/intake-quote-handoff";
import {
  addRequestDraftLines,
  draftEstimateSendError,
} from "@/lib/request-estimate-draft";
import {
  estimateEmailIdempotencyKey,
  getMailConfig,
  isMailSendAttemptId,
  isUsableEmail,
  senderFrom,
  sendTransactionalEmail,
} from "@/lib/mail";
import { prisma } from "@/lib/prisma";

export type EstimateActionState = {
  error?: string;
  message?: string;
};

function readString(formData: FormData, key: string) {
  const value = formData.get(key);
  return typeof value === "string" ? value.trim() : "";
}

function readVariableScopePayload(formData: FormData): {
  inputs: Record<string, unknown>;
  rates: Record<string, unknown>;
} | null {
  const raw = formData.get("variableScopePayload");
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as {
      inputs?: unknown;
      rates?: unknown;
    };
    if (!parsed || typeof parsed !== "object") return null;
    return {
      inputs:
        parsed.inputs && typeof parsed.inputs === "object" && !Array.isArray(parsed.inputs)
          ? (parsed.inputs as Record<string, unknown>)
          : {},
      rates:
        parsed.rates && typeof parsed.rates === "object" && !Array.isArray(parsed.rates)
          ? (parsed.rates as Record<string, unknown>)
          : {},
    };
  } catch {
    return null;
  }
}

function decorativeWallPanelingFormFields(formData: FormData) {
  return {
    inputs: {
      wallWidthFt: readString(formData, "wallWidthFt"),
      wallHeightFt: readString(formData, "wallHeightFt"),
      removalType: readString(formData, "removalType"),
      panelQuantity: readString(formData, "panelQuantity"),
      slidingPatioDoors: readString(formData, "slidingPatioDoors"),
      standardDoors: readString(formData, "standardDoors"),
      windows: readString(formData, "windows"),
      receptacles: readString(formData, "receptacles"),
      switches: readString(formData, "switches"),
      lightFixtures: readString(formData, "lightFixtures"),
      trimAllowance: readString(formData, "trimAllowance"),
      cleanupAllowance: readString(formData, "cleanupAllowance"),
      contentsHandlingLevel: readString(formData, "contentsHandlingLevel"),
      contentsHandlingCustomAmount: readString(formData, "contentsHandlingCustomAmount"),
      contentsProtectionLevel: readString(formData, "contentsProtectionLevel"),
      contentsProtectionCustomAmount: readString(formData, "contentsProtectionCustomAmount"),
      belongingsCleanupLevel: readString(formData, "belongingsCleanupLevel"),
      belongingsCleanupCustomAmount: readString(formData, "belongingsCleanupCustomAmount"),
      notes: readString(formData, "notes"),
    },
    rates: {
      panelRate: readString(formData, "panelRate"),
      removalRatePerSqFt: readString(formData, "removalRatePerSqFt"),
      slidingPatioDoorRate: readString(formData, "slidingPatioDoorRate"),
      standardDoorRate: readString(formData, "standardDoorRate"),
      windowRate: readString(formData, "windowRate"),
      receptacleRate: readString(formData, "receptacleRate"),
      switchRate: readString(formData, "switchRate"),
      lightFixtureRate: readString(formData, "lightFixtureRate"),
      defaultTrimAllowance: readString(formData, "defaultTrimAllowance"),
      defaultCleanupAllowance: readString(formData, "defaultCleanupAllowance"),
      contentsHandlingLightRate: readString(formData, "contentsHandlingLightRate"),
      contentsHandlingModerateRate: readString(formData, "contentsHandlingModerateRate"),
      contentsHandlingHeavyRate: readString(formData, "contentsHandlingHeavyRate"),
      contentsProtectionLightRate: readString(formData, "contentsProtectionLightRate"),
      contentsProtectionModerateRate: readString(formData, "contentsProtectionModerateRate"),
      contentsProtectionHeavyRate: readString(formData, "contentsProtectionHeavyRate"),
      belongingsCleanupLightRate: readString(formData, "belongingsCleanupLightRate"),
      belongingsCleanupModerateRate: readString(formData, "belongingsCleanupModerateRate"),
      belongingsCleanupHeavyRate: readString(formData, "belongingsCleanupHeavyRate"),
    },
  };
}

function parseDecimal(raw: string, allowZero = false) {
  if (!raw) {
    return null;
  }
  try {
    const value = new Prisma.Decimal(raw);
    if (value.isNaN() || value.lt(0) || (!allowZero && value.lte(0))) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export async function createEstimate(serviceRequestId: string) {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const request = access.assertOwned(
    await prisma.serviceRequest.findFirst({
      where: { id: serviceRequestId, ...access.scope },
      include: {
        items: {
          orderBy: { sortOrder: "asc" },
          include: {
            serviceCatalogItem: {
              select: {
                id: true,
                name: true,
                pricingMode: true,
                price: true,
                description: true,
              },
            },
          },
        },
        measurements: {
          select: {
            source: true,
            width: true,
            height: true,
            length: true,
            quantity: true,
            unit: true,
            serviceRequestItem: {
              select: { serviceCatalogItemId: true },
            },
          },
        },
        serviceCatalogItem: {
          select: {
            id: true,
            name: true,
            pricingMode: true,
            price: true,
            description: true,
          },
        },
      },
    }),
  );

  const existing = await prisma.estimate.findFirst({
    where: {
      ...access.scope,
      serviceRequestId: request.id,
    },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });

  if (existing) {
    redirect(`/estimates/${existing.id}`);
  }

  const sourceItems =
    request.items.length > 0
      ? request.items
      : request.serviceCatalogItem
        ? [{ quantity: 1, serviceCatalogItem: request.serviceCatalogItem }]
        : [];

  const estimate = await prisma.$transaction(async (tx) => {
    const raced = await tx.estimate.findFirst({
      where: {
        businessId: access.businessId,
        serviceRequestId: request.id,
      },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (raced) {
      return raced;
    }

    const created = await tx.estimate.create({
      data: {
        businessId: access.businessId,
        serviceRequestId: request.id,
        customerId: request.customerId,
        propertyId: request.propertyId,
        total: new Prisma.Decimal(0),
        publicToken: randomUUID(),
      },
    });

    await addRequestDraftLines(tx, {
      businessId: access.businessId,
      estimateId: created.id,
      items: sourceItems,
      workAreaIntake: parseWorkAreaIntake(request.description),
      measurements: request.measurements.map((row) => toStoredIntakeMeasurement(row)),
    });
    await persistDraftEstimateTotal(tx, created.id, access.businessId);

    // An OPEN request that has become an estimate is no longer waiting on
    // the owner to act on it, so it should stop counting as "open".
    if (request.status === "OPEN") {
      await tx.serviceRequest.update({
        where: { id: request.id },
        data: { status: "CONVERTED" },
      });
    }

    return created;
  });

  revalidatePath("/requests");
  revalidatePath("/dashboard");
  revalidatePath("/pipeline");
  redirect(`/estimates/${estimate.id}`);
}

async function findReusableCustomer(
  db: {
    customer: {
      findFirst: (args: {
        where: { businessId: string; email?: string; phone?: string };
      }) => Promise<{ id: string; businessId: string } | null>;
    };
  },
  businessId: string,
  email: string,
  phone: string,
) {
  if (email) {
    const byEmail = await db.customer.findFirst({
      where: { businessId, email },
    });
    if (byEmail) {
      return byEmail;
    }
  }

  if (phone) {
    return db.customer.findFirst({
      where: { businessId, phone },
    });
  }

  return null;
}

async function resolveManualEstimateProperty({
  access,
  customerId,
  propertyChoice,
  address,
}: {
  access: BusinessAccess;
  customerId: string;
  propertyChoice: string;
  address: string;
}): Promise<{ ok: true; id: string | null } | { ok: false; error: string }> {
  if (!propertyChoice || propertyChoice === "none") {
    return { ok: true, id: null };
  }

  if (propertyChoice === "new") {
    if (!address) {
      return { ok: false, error: "Enter a service address." };
    }

    const created = await prisma.property.create({
      data: {
        businessId: access.businessId,
        customerId,
        addressLine1: address,
      },
    });
    return { ok: true, id: created.id };
  }

  const property = await prisma.property.findFirst({
    where: {
      id: propertyChoice,
      customerId,
      ...access.scope,
    },
  });
  if (!property) {
    return {
      ok: false,
      error: "That service address is not available for this customer.",
    };
  }
  access.assertOwned(property);

  return { ok: true, id: property.id };
}

export async function createManualEstimate(
  _prev: EstimateActionState,
  formData: FormData,
): Promise<EstimateActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const mode = readString(formData, "mode");

  if (mode !== "existing" && mode !== "new") {
    return { error: "Choose an existing customer or enter a new customer." };
  }

  if (mode === "existing") {
    const selectedId = readString(formData, "customerId");
    if (!selectedId) {
      return { error: "Choose a customer." };
    }

    const customer = access.assertOwned(
      await prisma.customer.findFirst({
        where: { id: selectedId, ...access.scope },
      }),
    );

    const propertyChoice = readString(formData, "propertyChoice");
    const address = readString(formData, "address");
    const property = await resolveManualEstimateProperty({
      access,
      customerId: customer.id,
      propertyChoice,
      address,
    });
    if (!property.ok) {
      return { error: property.error };
    }

    const estimate = await prisma.estimate.create({
      data: {
        businessId: access.businessId,
        customerId: customer.id,
        propertyId: property.id,
        total: new Prisma.Decimal(0),
        publicToken: randomUUID(),
      },
    });

    revalidatePath("/estimates");
    revalidatePath("/customers");
    revalidatePath("/pipeline");
    redirect(`/estimates/${estimate.id}`);
  }

  const name = readString(formData, "name");
  const email = readString(formData, "email").toLowerCase();
  const phone = readString(formData, "phone");
  const address = readString(formData, "address");

  if (!name) {
    return { error: "Customer name is required." };
  }

  const estimate = await prisma.$transaction(async (tx) => {
    const existing = await findReusableCustomer(
      tx,
      access.businessId,
      email,
      phone,
    );
    const customer = existing
      ? access.assertOwned(existing)
      : await tx.customer.create({
          data: {
            businessId: access.businessId,
            name,
            email: email || null,
            phone: phone || null,
          },
        });

    let propertyId: string | null = null;
    if (address) {
      const createdProperty = await tx.property.create({
        data: {
          businessId: access.businessId,
          customerId: customer.id,
          addressLine1: address,
        },
      });
      propertyId = createdProperty.id;
    }

    return tx.estimate.create({
      data: {
        businessId: access.businessId,
        customerId: customer.id,
        propertyId,
        total: new Prisma.Decimal(0),
        publicToken: randomUUID(),
      },
    });
  });

  revalidatePath("/estimates");
  revalidatePath("/customers");
  revalidatePath("/pipeline");
  redirect(`/estimates/${estimate.id}`);
}

export async function addCatalogLineItem(
  _prev: EstimateActionState,
  formData: FormData,
): Promise<EstimateActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const estimateId = readString(formData, "estimateId");
  const catalogItemId = readString(formData, "catalogItemId");
  const quantity = parseDecimal(readString(formData, "quantity"));

  if (!estimateId || !catalogItemId || !quantity) {
    return { error: "Catalog item and a quantity greater than 0 are required." };
  }

  try {
    await addCatalogItemToDraftEstimate(prisma, access, {
      estimateId,
      catalogItemId,
      quantity,
      unitPrice: parseDecimal(readString(formData, "unitPrice")),
    });
  } catch (error) {
    return { error: estimateLineErrorMessage(error, "Could not add that service.") };
  }

  revalidatePath(`/estimates/${estimateId}`);
  return {};
}

export async function addCustomLineItem(
  _prev: EstimateActionState,
  formData: FormData,
): Promise<EstimateActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const estimateId = readString(formData, "estimateId");
  const description = readString(formData, "description");
  const quantity = parseDecimal(readString(formData, "quantity"));
  const unitPrice = parseDecimal(readString(formData, "unitPrice"), true);
  const type = readString(formData, "type");

  if (!estimateId || !description || !quantity || !unitPrice) {
    return { error: "Description, quantity, and unit price are required." };
  }

  if (type !== "LABOR" && type !== "MATERIAL" && type !== "OTHER") {
    return { error: "Choose Labor, Material, or Other." };
  }

  const estimate = access.assertOwned(
    await prisma.estimate.findFirst({
      where: { id: estimateId, ...access.scope },
    }),
  );

  if (estimate.status !== "DRAFT") {
    return { error: "Only a draft estimate can be changed." };
  }

  const total = quantity.mul(unitPrice);

  await prisma.$transaction(async (tx) => {
    await tx.lineItem.create({
      data: {
        businessId: access.businessId,
        estimateId: estimate.id,
        description: joinLineDescription(
          description,
          typeof formData.get("includedWork") === "string"
            ? String(formData.get("includedWork"))
            : "",
        ),
        quantity,
        unitPrice,
        total,
        type,
      },
    });
    await persistDraftEstimateTotal(tx, estimate.id, access.businessId);
  });

  revalidatePath(`/estimates/${estimate.id}`);
  return {};
}

export async function priceEstimateLineItem(
  _prev: EstimateActionState,
  formData: FormData,
): Promise<EstimateActionState> {
  try {
    const access = await requireBusinessAccess();
    await priceDraftEstimateLine(prisma, access, {
      estimateId: readString(formData, "estimateId"),
      lineItemId: readString(formData, "lineItemId"),
      unitPrice: readString(formData, "unitPrice"),
      quantity: readString(formData, "quantity") || undefined,
    });
    revalidatePath(`/estimates/${readString(formData, "estimateId")}`);
    return { message: "Price saved." };
  } catch (error) {
    return { error: estimateLineErrorMessage(error, "Could not save that price.") };
  }
}

export async function updateEstimateLineIncludedWork(
  _prev: EstimateActionState,
  formData: FormData,
): Promise<EstimateActionState> {
  try {
    const estimateId = readString(formData, "estimateId");
    const access = await requireBusinessAccess();
    await updateDraftEstimateLineIncludedWork(prisma, access, {
      estimateId,
      lineItemId: readString(formData, "lineItemId"),
      includedWork: typeof formData.get("includedWork") === "string"
        ? String(formData.get("includedWork"))
        : "",
    });
    revalidatePath(`/estimates/${estimateId}`);
    return { message: "Scope saved." };
  } catch (error) {
    return {
      error: estimateLineErrorMessage(error, "Could not save that scope."),
    };
  }
}

export async function applyEstimateCalculator(
  _prev: EstimateActionState,
  formData: FormData,
): Promise<EstimateActionState> {
  try {
    const estimateId = readString(formData, "estimateId");
    const access = await requireBusinessAccess();
    const calculatorFields =
      readVariableScopePayload(formData) ?? decorativeWallPanelingFormFields(formData);
    await applyDraftEstimateCalculator(prisma, access, {
      estimateId,
      lineItemId: readString(formData, "lineItemId"),
      inputs: calculatorFields.inputs,
      rates: calculatorFields.rates,
      customerPolicies: [
        {
          id: readString(formData, "customerPolicyId") || "work-area-personal-property",
          title: readString(formData, "customerPolicyTitle") || "Work Area & Personal Property",
          body: readString(formData, "customerPolicyBody"),
        },
      ].filter((policy) => policy.body),
    });
    revalidatePath(`/estimates/${estimateId}`);
    return { message: "Recommended labor price applied." };
  } catch (error) {
    return {
      error: estimateLineErrorMessage(error, "Could not apply that recommended price."),
    };
  }
}

export async function persistEstimateCalculatorRates(
  formData: FormData,
): Promise<EstimateActionState> {
  try {
    const payload = readVariableScopePayload(formData);
    const calculatorFields = payload ?? decorativeWallPanelingFormFields(formData);
    await persistDraftEstimateCalculatorRates(prisma, await requireBusinessAccess(), {
      estimateId: readString(formData, "estimateId"),
      lineItemId: readString(formData, "lineItemId"),
      rates: calculatorFields.rates,
      inputs: payload?.inputs,
      customerPolicies: readString(formData, "customerPolicyBody")
        ? [
            {
              id: readString(formData, "customerPolicyId") || "work-area-personal-property",
              title:
                readString(formData, "customerPolicyTitle") ||
                "Work Area & Personal Property",
              body: readString(formData, "customerPolicyBody"),
            },
          ]
        : null,
    });
    return { message: "Calculator rates saved as the business default." };
  } catch (error) {
    return {
      error: estimateLineErrorMessage(error, "Could not save those calculator rates."),
    };
  }
}

export async function saveEstimateMaterialTakeoff(
  _prev: EstimateActionState,
  formData: FormData,
): Promise<EstimateActionState> {
  try {
    const estimateId = readString(formData, "estimateId");
    const snapshot = parseTakeoffFormSnapshot(readString(formData, "takeoffJson"));
    if (!snapshot) {
      return { error: "Calculate or enter a material takeoff before saving." };
    }
    const access = await requireBusinessAccess();
    await saveDraftMaterialTakeoff(prisma, access, {
      estimateId,
      lineItemId: readString(formData, "lineItemId"),
      snapshot,
    });
    revalidatePath(`/estimates/${estimateId}`);
    return { message: "Material takeoff saved." };
  } catch (error) {
    return {
      error: estimateLineErrorMessage(error, "Could not save that material takeoff."),
    };
  }
}

export async function recalculateEstimateMaterialTakeoff(
  _prev: EstimateActionState,
  formData: FormData,
): Promise<EstimateActionState> {
  try {
    const estimateId = readString(formData, "estimateId");
    const takeoffType = readString(formData, "takeoffType");
    if (!isTakeoffTypeId(takeoffType)) {
      return { error: "Choose a material takeoff type." };
    }
    const snapshot = parseTakeoffFormSnapshot(readString(formData, "takeoffJson"));
    const access = await requireBusinessAccess();
    await recalculateDraftMaterialTakeoff(prisma, access, {
      estimateId,
      lineItemId: readString(formData, "lineItemId"),
      takeoffType,
      inputs: snapshot?.inputs,
      wastePercent: snapshot?.wastePercent,
      measurementSource: snapshot?.measurementSource,
      skippedMeasurements: snapshot?.skippedMeasurements,
      snapshotEdits: snapshot,
    });
    revalidatePath(`/estimates/${estimateId}`);
    return { message: "Material takeoff recalculated. Owner quantity and unit-cost edits were kept." };
  } catch (error) {
    return {
      error: estimateLineErrorMessage(error, "Could not calculate that material takeoff."),
    };
  }
}

export async function convertEstimateMaterialTakeoff(
  _prev: EstimateActionState,
  formData: FormData,
): Promise<EstimateActionState> {
  try {
    const estimateId = readString(formData, "estimateId");
    const snapshot = parseTakeoffFormSnapshot(readString(formData, "takeoffJson"));
    const access = await requireBusinessAccess();
    const result = await convertDraftMaterialTakeoff(prisma, access, {
      estimateId,
      lineItemId: readString(formData, "lineItemId"),
      snapshot,
    });
    revalidatePath(`/estimates/${estimateId}`);
    if (result.created === 0) {
      return {
        message:
          "No new MATERIAL lines were added. Selected items were already converted or had a quantity of 0.",
      };
    }
    return {
      message: `Added ${result.created} MATERIAL line${result.created === 1 ? "" : "s"} from takeoff. Repeat convert will not duplicate them.`,
    };
  } catch (error) {
    return {
      error: estimateLineErrorMessage(
        error,
        "Could not convert that material takeoff into MATERIAL lines.",
      ),
    };
  }
}

export async function overrideEstimateLinePrice(
  _prev: EstimateActionState,
  formData: FormData,
): Promise<EstimateActionState> {
  try {
    const estimateId = readString(formData, "estimateId");
    const access = await requireBusinessAccess();
    await overrideDraftEstimateLinePrice(prisma, access, {
      estimateId,
      lineItemId: readString(formData, "lineItemId"),
      unitPrice: readString(formData, "unitPrice"),
    });
    revalidatePath(`/estimates/${estimateId}`);
    return { message: "Line price updated." };
  } catch (error) {
    return {
      error: estimateLineErrorMessage(error, "Could not override that price."),
    };
  }
}

export async function saveEstimateLineForReuse(
  _prev: EstimateActionState,
  formData: FormData,
): Promise<EstimateActionState> {
  try {
    const estimateId = readString(formData, "estimateId");
    const access = await requireBusinessAccess();
    const catalog = await saveDraftEstimateLineAsCatalog(prisma, access, {
      estimateId,
      lineItemId: readString(formData, "lineItemId"),
      savePrice: readString(formData, "savePrice") === "1",
    });
    revalidatePath(`/estimates/${estimateId}`);
    revalidatePath("/services");
    return { message: `Saved “${catalog.name}” to the catalog.` };
  } catch (error) {
    return {
      error: estimateLineErrorMessage(error, "Could not save that service for reuse."),
    };
  }
}

export async function setEstimateLaborMinimumWaived(
  estimateId: string,
  waived: boolean,
): Promise<EstimateActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const estimate = access.assertOwned(
    await prisma.estimate.findFirst({
      where: { id: estimateId, ...access.scope },
    }),
  );

  if (estimate.status !== "DRAFT") {
    return { error: "Only a draft estimate can be changed." };
  }

  await prisma.$transaction(async (tx) => {
    await tx.estimate.update({
      where: { id: estimate.id },
      data: { laborMinimumWaived: waived },
    });
    await persistDraftEstimateTotal(tx, estimate.id, access.businessId);
  });

  revalidatePath(`/estimates/${estimate.id}`);
  return {};
}

export async function removeEstimateLineItem(
  _prev: EstimateActionState,
  formData: FormData,
): Promise<EstimateActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const estimateId = readString(formData, "estimateId");
  const lineItemId = readString(formData, "lineItemId");

  if (!estimateId || !lineItemId) {
    return { error: "That line item could not be removed." };
  }

  const estimate = access.assertOwned(
    await prisma.estimate.findFirst({
      where: { id: estimateId, ...access.scope },
    }),
  );

  if (estimate.status !== "DRAFT") {
    return { error: "Only a draft estimate can be changed." };
  }

  const lineItem = access.assertOwned(
    await prisma.lineItem.findFirst({
      where: {
        id: lineItemId,
        estimateId: estimate.id,
        ...access.scope,
      },
    }),
  );

  await prisma.$transaction(async (tx) => {
    await tx.lineItem.deleteMany({
      where: {
        id: lineItem.id,
        estimateId: estimate.id,
        businessId: access.businessId,
      },
    });
    await persistDraftEstimateTotal(tx, estimate.id, access.businessId);
  });

  revalidatePath(`/estimates/${estimate.id}`);
  return {};
}

export async function clearDraftEstimate(
  _prev: EstimateActionState,
  formData: FormData,
): Promise<EstimateActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const estimateId = readString(formData, "estimateId");

  if (!estimateId) {
    return { error: "That estimate could not be cleared." };
  }

  const estimate = access.assertOwned(
    await prisma.estimate.findFirst({
      where: { id: estimateId, ...access.scope },
    }),
  );

  if (estimate.status !== "DRAFT") {
    return { error: "Only a draft estimate can be changed." };
  }

  await prisma.$transaction(async (tx) => {
    await tx.lineItem.deleteMany({
      where: {
        estimateId: estimate.id,
        businessId: access.businessId,
      },
    });
    await persistDraftEstimateTotal(tx, estimate.id, access.businessId);
  });

  revalidatePath(`/estimates/${estimate.id}`);
  return {};
}

export async function sendEstimate(
  _prev: EstimateActionState,
  formData: FormData,
): Promise<EstimateActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const estimateId = readString(formData, "estimateId");

  if (!estimateId) {
    return { error: "That estimate could not be sent." };
  }

  const estimate = access.assertOwned(
    await prisma.estimate.findFirst({
      where: { id: estimateId, ...access.scope },
      include: { lineItems: { select: { id: true, description: true, unitPrice: true } } },
    }),
  );

  const blocked = draftEstimateSendError(estimate);
  if (blocked) {
    return { error: blocked };
  }

  const result = await prisma.$transaction(async (tx) => {
    const current = await tx.estimate.findFirst({
      where: { id: estimate.id, businessId: access.businessId },
      include: { lineItems: { select: { id: true, description: true, unitPrice: true } } },
    });

    if (!current) {
      return { error: "That estimate could not be sent." };
    }
    const currentBlocked = draftEstimateSendError(current);
    if (currentBlocked) {
      return { error: currentBlocked };
    }

    await persistDraftEstimateTotal(tx, estimate.id, access.businessId);

    const updated = await tx.estimate.updateMany({
      where: {
        id: estimate.id,
        businessId: access.businessId,
        status: "DRAFT",
      },
      data: { status: "SENT" },
    });

    if (updated.count !== 1) {
      return { error: "Only a draft estimate can be sent." };
    }

    // Snapshot creation happens only after the guarded status transition
    // above has succeeded, and in the same transaction: if this throws
    // (e.g. the (estimateId, versionNumber) unique constraint), the whole
    // transaction -- including the SENT status change -- rolls back, so an
    // estimate is never left marked SENT without a matching version.
    await createEstimateVersionSnapshot(tx, {
      estimateId: estimate.id,
      businessId: access.businessId,
    });

    return {};
  });

  if (result.error) {
    return result;
  }

  revalidatePath("/estimates");
  revalidatePath(`/estimates/${estimate.id}`);
  revalidatePath(`/e/${estimate.publicToken}`);
  revalidatePath("/pipeline");
  return {};
}

export async function returnEstimateToDraft(
  _prev: EstimateActionState,
  formData: FormData,
): Promise<EstimateActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const estimateId = readString(formData, "estimateId");

  if (!estimateId) {
    return { error: "That estimate could not be returned to draft." };
  }

  const estimate = access.assertOwned(
    await prisma.estimate.findFirst({
      where: { id: estimateId, ...access.scope },
    }),
  );

  if (estimate.status !== "SENT") {
    return { error: "Only a sent estimate can be returned to draft." };
  }

  const updated = await prisma.estimate.updateMany({
    where: {
      id: estimate.id,
      businessId: access.businessId,
      status: "SENT",
    },
    data: { status: "DRAFT" },
  });

  if (updated.count !== 1) {
    return { error: "Only a sent estimate can be returned to draft." };
  }

  revalidatePath("/estimates");
  revalidatePath(`/estimates/${estimate.id}`);
  revalidatePath(`/e/${estimate.publicToken}`);
  revalidatePath("/pipeline");
  return {};
}

export async function emailSentEstimate(
  _prev: EstimateActionState,
  formData: FormData,
): Promise<EstimateActionState> {
  const access = await requireBusinessAccess();
  requireBusinessCapability(access, CAPABILITIES.MANAGE_ESTIMATES);
  const estimateId = readString(formData, "estimateId");
  const sendAttemptId = readString(formData, "sendAttemptId");

  if (!estimateId) {
    return { error: "That estimate could not be emailed." };
  }
  if (!isMailSendAttemptId(sendAttemptId)) {
    return { error: "That estimate could not be emailed." };
  }

  const estimate = access.assertOwned(
    await prisma.estimate.findFirst({
      where: { id: estimateId, ...access.scope },
      include: {
        customer: { select: { name: true, email: true } },
        property: {
          select: {
            addressLine1: true,
            addressLine2: true,
            city: true,
            region: true,
            postalCode: true,
          },
        },
      },
    }),
  );

  if (estimate.status !== "SENT") {
    return { error: "Only a sent estimate can be emailed." };
  }

  const recipient = estimate.customer?.email?.trim() ?? "";
  if (!isUsableEmail(recipient)) {
    return {
      error:
        "No customer email on file. Add/copy the estimate link manually.",
    };
  }

  const config = getMailConfig();
  if ("error" in config) {
    return { error: config.error };
  }

  const email = buildEstimateReadyEmail({
    businessName: access.workspace.business.name,
    customerName: estimate.customer?.name ?? null,
    total: estimate.total,
    address: formatEstimateServiceAddress(estimate.property),
    approveUrl: `${config.appUrl}/e/${estimate.publicToken}`,
  });

  const sent = await sendTransactionalEmail({
    apiKey: config.apiKey,
    from: senderFrom(access.workspace.business.name, config.fromAddress),
    to: recipient,
    subject: email.subject,
    html: email.html,
    text: email.text,
    kind: "estimate",
    idempotencyKey: estimateEmailIdempotencyKey(estimate.id, sendAttemptId),
  });

  if (sent.error) {
    return { error: sent.error };
  }

  revalidatePath(`/estimates/${estimate.id}`);
  return { message: `Estimate emailed to ${recipient}` };
}
