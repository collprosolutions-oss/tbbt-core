/**
 * Additional Work → Change Order handoff.
 *
 * Proves the owner review/create-draft path uses the existing
 * AdditionalWorkRequest.changeOrderId relation, stays DRAFT, does not
 * rewrite approved estimate/invoice totals, and surfaces recorded request
 * context. Does not require a Next.js build.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-additional-work-change-order-handoff.mjs
 */
import { createRequire, register } from "node:module";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  CAPABILITIES,
  requireBusinessCapability,
} from "../src/lib/authorization.ts";
import {
  persistDraftChangeOrderTotal,
  resolveCurrentApprovedProjectTotal,
} from "../src/lib/change-order.ts";
import { resolveApprovedWorkOrderScope } from "../src/lib/job-work-order.ts";
import { requestedWorkLabels } from "../src/lib/service-request-work.ts";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);
const { createCustomerAdditionalWorkRequest } = await import(
  "@/lib/additional-work-request"
);
const { addChangeOrderDraftLines } = await import("@/lib/request-estimate-draft");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error(
    "DATABASE_URL must be set (pointing at a reachable Postgres server) to run this check.",
  );
  process.exit(1);
}

const repoRoot = new URL("..", import.meta.url).pathname;

const testDbName = "tbbt_aw_co_handoff_test";
const parsed = new URL(baseUrl);
parsed.pathname = `/${testDbName}`;
const testUrl = parsed.toString();

const push = spawnSync(
  "npx",
  ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"],
  { stdio: "inherit", env: { ...process.env, DATABASE_URL: testUrl } },
);

if (push.status !== 0) {
  console.error("Failed to push schema for additional-work change-order handoff test database.");
  process.exit(push.status ?? 1);
}

const require = createRequire(import.meta.url);
const { PrismaClient, Prisma } = require("@prisma/client");

const prisma = new PrismaClient({ datasourceUrl: testUrl });

let failures = 0;
function check(label, condition) {
  if (condition) {
    console.log(`  ok  - ${label}`);
  } else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

function readRepo(path) {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

function makeAccess(businessId, role) {
  return {
    businessId,
    workspace: { role },
    scope: { businessId },
    assertOwned(record) {
      if (!record || record.businessId !== businessId) {
        throw new Error("Record is not in the authorized business workspace.");
      }
      return record;
    },
  };
}

/** Mirrors loadLinkedChangeOrderSourceRequests in change-order-list.tsx. */
async function loadLinkedChangeOrderSourceRequests(access, input) {
  if (input.changeOrderIds.length === 0) {
    return [];
  }
  const linkedRequests = await prisma.additionalWorkRequest.findMany({
    where: {
      businessId: access.businessId,
      jobId: input.jobId,
      changeOrderId: { in: input.changeOrderIds },
    },
    select: {
      id: true,
      businessId: true,
      changeOrderId: true,
      description: true,
      source: true,
    },
  });
  return linkedRequests.map((request) => access.assertOwned(request));
}

/** Mirrors src/app/actions/change-order.ts createChangeOrder(). */
async function mirrorCreateChangeOrder(access, form) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CHANGE_ORDERS);
  const jobId = typeof form.jobId === "string" ? form.jobId.trim() : "";
  const title = typeof form.title === "string" ? form.title.trim() : "";
  const additionalWorkRequestId =
    typeof form.additionalWorkRequestId === "string"
      ? form.additionalWorkRequestId.trim()
      : "";

  if (!jobId || !title) {
    return { error: "A title is required to create a change order." };
  }

  const job = access.assertOwned(
    await prisma.job.findFirst({ where: { id: jobId, ...access.scope } }),
  );

  let sourceRequest = null;
  if (additionalWorkRequestId) {
    sourceRequest = access.assertOwned(
      await prisma.additionalWorkRequest.findFirst({
        where: {
          id: additionalWorkRequestId,
          jobId: job.id,
          ...access.scope,
        },
        select: {
          id: true,
          businessId: true,
          jobId: true,
          changeOrderId: true,
          status: true,
          items: {
            orderBy: { sortOrder: "asc" },
            select: {
              quantity: true,
              customDescription: true,
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
        },
      }),
    );
    if (
      sourceRequest.jobId !== job.id ||
      sourceRequest.businessId !== job.businessId
    ) {
      return { error: "That request could not be found." };
    }
    if (sourceRequest.status !== "OPEN" || sourceRequest.changeOrderId) {
      return { error: "That request has already been handled." };
    }
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const changeOrder = await tx.changeOrder.create({
        data: {
          businessId: access.businessId,
          jobId: job.id,
          title,
          status: "DRAFT",
        },
      });

      const sourceRequestId = sourceRequest?.id ?? null;
      if (sourceRequestId) {
        const linked = await tx.additionalWorkRequest.updateMany({
          where: {
            id: sourceRequestId,
            businessId: access.businessId,
            jobId: job.id,
            status: "OPEN",
            changeOrderId: null,
          },
          data: {
            status: "CONVERTED",
            changeOrderId: changeOrder.id,
            reviewedAt: new Date(),
          },
        });
        if (linked.count !== 1) {
          throw new Error("That request has already been handled.");
        }
        if (
          sourceRequest &&
          sourceRequest.items.some((item) => item.serviceCatalogItem)
        ) {
          await addChangeOrderDraftLines(tx, {
            businessId: access.businessId,
            changeOrderId: changeOrder.id,
            items: sourceRequest.items,
          });
          await persistDraftChangeOrderTotal(tx, changeOrder.id, access.businessId);
        }
      }

      return changeOrder;
    });
    return { changeOrder: created };
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? error.message
          : "That request has already been handled.",
    };
  }
}

/** Mirrors src/app/actions/additional-work-request.ts dismissAdditionalWorkRequest(). */
async function mirrorDismissAdditionalWorkRequest(access, requestId) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CHANGE_ORDERS);
  const request = access.assertOwned(
    await prisma.additionalWorkRequest.findFirst({
      where: { id: requestId, ...access.scope },
    }),
  );
  if (request.status !== "OPEN") {
    return { error: "That request has already been handled." };
  }
  const updated = await prisma.additionalWorkRequest.updateMany({
    where: { id: request.id, businessId: access.businessId, status: "OPEN" },
    data: { status: "DISMISSED", reviewedAt: new Date() },
  });
  if (updated.count !== 1) {
    return { error: "That request has already been handled." };
  }
  return {};
}

async function mirrorAddChangeOrderLineItem(access, changeOrderId, data) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CHANGE_ORDERS);
  const changeOrder = access.assertOwned(
    await prisma.changeOrder.findFirst({
      where: { id: changeOrderId, ...access.scope },
    }),
  );
  if (changeOrder.status !== "DRAFT") {
    throw new Error("Only a draft change order can be edited.");
  }
  const total = data.quantity.mul(data.unitPrice);
  return prisma.$transaction(async (tx) => {
    const item = await tx.lineItem.create({
      data: {
        businessId: access.businessId,
        changeOrderId: changeOrder.id,
        description: data.description,
        quantity: data.quantity,
        unitPrice: data.unitPrice,
        total,
        type: data.type ?? "LABOR",
      },
    });
    await persistDraftChangeOrderTotal(tx, changeOrder.id, access.businessId);
    return item;
  });
}

async function mirrorSendChangeOrder(access, changeOrderId) {
  requireBusinessCapability(access, CAPABILITIES.MANAGE_CHANGE_ORDERS);
  const changeOrder = access.assertOwned(
    await prisma.changeOrder.findFirst({
      where: { id: changeOrderId, ...access.scope },
      include: { lineItems: { select: { id: true } } },
    }),
  );
  if (changeOrder.status !== "DRAFT") {
    return { error: "Only a draft change order can be sent." };
  }
  if (changeOrder.lineItems.length === 0) {
    return { error: "Add at least one line item before sending." };
  }
  const updated = await prisma.changeOrder.updateMany({
    where: {
      id: changeOrder.id,
      businessId: access.businessId,
      status: "DRAFT",
    },
    data: { status: "SENT", sentAt: new Date() },
  });
  if (updated.count !== 1) {
    return { error: "Only a draft change order can be sent." };
  }
  return {};
}

const LINE_ITEM_SELECT = {
  id: true,
  description: true,
  quantity: true,
  unitPrice: true,
  total: true,
  type: true,
};

async function fetchJobForScope(jobId) {
  return prisma.job.findFirstOrThrow({
    where: { id: jobId },
    include: {
      estimate: {
        include: {
          lineItems: { select: LINE_ITEM_SELECT },
        },
      },
      approvedEstimateVersion: {
        include: {
          lineItems: { select: LINE_ITEM_SELECT },
        },
      },
      changeOrders: { select: { status: true, total: true } },
    },
  });
}

async function simulateSendEstimate(estimateId, businessId) {
  const { createEstimateVersionSnapshot } = await import(
    "../src/lib/estimate-version.ts"
  );
  return prisma.$transaction(async (tx) => {
    const current = await tx.estimate.findFirst({
      where: { id: estimateId, businessId },
      include: { lineItems: { select: { id: true } } },
    });
    if (!current || current.status !== "DRAFT" || current.lineItems.length === 0) {
      return { ok: false };
    }
    const updated = await tx.estimate.updateMany({
      where: { id: estimateId, businessId, status: "DRAFT" },
      data: { status: "SENT" },
    });
    if (updated.count !== 1) {
      return { ok: false };
    }
    const version = await createEstimateVersionSnapshot(tx, { estimateId, businessId });
    return { ok: true, version };
  });
}

async function simulateApproveEstimate(estimateId) {
  const { findCurrentEstimateVersion } = await import(
    "../src/lib/estimate-version.ts"
  );
  return prisma.$transaction(async (tx) => {
    const current = await tx.estimate.findFirst({
      where: { id: estimateId },
      select: { id: true, businessId: true, status: true },
    });
    if (!current || current.status !== "SENT") {
      return { ok: false };
    }
    const currentVersion = await findCurrentEstimateVersion(tx, current.id);
    if (!currentVersion) {
      return { ok: false };
    }
    const updated = await tx.estimate.updateMany({
      where: { id: current.id, status: "SENT" },
      data: { status: "APPROVED", approvedVersionId: currentVersion.id },
    });
    if (updated.count !== 1) {
      return { ok: false };
    }
    await tx.estimateVersion.update({
      where: { id: currentVersion.id },
      data: { approvedAt: new Date() },
    });
    return { ok: true, versionId: currentVersion.id };
  });
}

async function createApprovedJob(businessId, customerId, propertyId, estimateTotal, label) {
  const estimate = await prisma.estimate.create({
    data: {
      businessId,
      customerId,
      propertyId,
      total: new Prisma.Decimal(estimateTotal),
      publicToken: randomUUID(),
    },
  });
  await prisma.lineItem.create({
    data: {
      businessId,
      estimateId: estimate.id,
      description: label,
      quantity: new Prisma.Decimal(1),
      unitPrice: new Prisma.Decimal(estimateTotal),
      total: new Prisma.Decimal(estimateTotal),
      type: "LABOR",
    },
  });
  await simulateSendEstimate(estimate.id, businessId);
  const approved = await simulateApproveEstimate(estimate.id);
  const job = await prisma.job.create({
    data: {
      businessId,
      customerId,
      propertyId,
      estimateId: estimate.id,
      approvedEstimateVersionId: approved.versionId,
      projectToken: randomUUID(),
      status: "IN_PROGRESS",
    },
  });
  return job;
}

const requestListSrc = readRepo("src/components/jobs/additional-work-request-list.tsx");
const changeOrderListSrc = readRepo("src/components/jobs/change-order-list.tsx");
const changeOrderActionSrc = readRepo("src/app/actions/change-order.ts");
const schemaSrc = readRepo("prisma/schema.prisma");

console.log("\nSTATIC — Existing AdditionalWorkRequest → ChangeOrder linkage");
check(
  "schema already links AdditionalWorkRequest.changeOrderId to ChangeOrder",
  schemaSrc.includes("changeOrderId String?") &&
    schemaSrc.includes("changeOrder ChangeOrder? @relation(fields: [changeOrderId]") &&
    schemaSrc.includes("additionalWorkRequests AdditionalWorkRequest[]"),
);
check(
  "handoff does not add a second source field or status/source enum",
  changeOrderActionSrc.includes("changeOrderId: created.id") &&
    !changeOrderActionSrc.includes("sourceRequestId String") &&
    !changeOrderActionSrc.includes("enum AdditionalWork") &&
    !requestListSrc.includes("opportunity") &&
    !changeOrderListSrc.includes("ticket model"),
);
check(
  "createChangeOrder still accepts additionalWorkRequestId from the existing UI",
  changeOrderActionSrc.includes('readString(\n    formData,\n    "additionalWorkRequestId"') ||
    changeOrderActionSrc.includes('"additionalWorkRequestId"'),
);
check(
  "owner request list still submits additionalWorkRequestId",
  requestListSrc.includes('name="additionalWorkRequestId"') &&
    requestListSrc.includes("createChangeOrder"),
);

console.log("\nSTATIC — Recorded request context on OPEN requests");
check(
  "customer vs employee copy stays distinct",
  requestListSrc.includes("Requested by customer") &&
    requestListSrc.includes("Reported by field employee") &&
    requestListSrc.includes('source === "EMPLOYEE"'),
);
check(
  "open request UI preserves description, service labels, quantities, and recorded time",
  requestListSrc.includes("requestedWorkLabels") &&
    requestListSrc.includes("Recorded description") &&
    requestListSrc.includes("Requested services") &&
    requestListSrc.includes("formatDateTime") &&
    requestListSrc.includes("Recorded {formatDateTime(request.createdAt)}"),
);
check(
  "Create Change Order title prefills from recorded service label / description",
  requestListSrc.includes("serviceLabels[0] ?? request.description") &&
    requestListSrc.includes("defaultValue={defaultTitle}"),
);
check(
  "draft-create copy does not approve or rewrite invoices/estimates",
  requestListSrc.includes("Creates a DRAFT Change Order from this recorded request") &&
    requestListSrc.includes("does not change invoices or the original estimate"),
);

console.log("\nSTATIC — Source context on Change Orders follows the existing relation");
check(
  "Change Order list follows additionalWorkRequest.changeOrderId",
  changeOrderListSrc.includes("prisma.additionalWorkRequest.findMany") &&
    changeOrderListSrc.includes("changeOrderId: { in:") &&
    changeOrderListSrc.includes("Source request:"),
);
check(
  "Change Order list distinguishes Customer request vs Field employee report",
  changeOrderListSrc.includes("Customer request") &&
    changeOrderListSrc.includes("Field employee report"),
);
check(
  "Change Order list shows recorded labels/description instead of a duplicated copy field",
  changeOrderListSrc.includes("requestedWorkLabels") &&
    changeOrderListSrc.includes("request.description") &&
    !changeOrderListSrc.includes("sourceRequestCopy"),
);
check(
  "Change Order list source query uses authenticated management businessId",
  changeOrderListSrc.includes("requireManagementPageAccess") &&
    changeOrderListSrc.includes("businessId: access.businessId") &&
    changeOrderListSrc.includes("const access = await requireManagementPageAccess()"),
);
check(
  "Change Order list does not trust a browser-supplied businessId",
  !changeOrderListSrc.includes("readString") &&
    !changeOrderListSrc.includes('formData.get("businessId")') &&
    !changeOrderListSrc.includes("businessId: jobId") &&
    !/\bbusinessId\s*:\s*string/.test(
      changeOrderListSrc.slice(
        changeOrderListSrc.indexOf("export async function ChangeOrderList"),
        changeOrderListSrc.indexOf("const access = await requireManagementPageAccess()"),
      ),
    ),
);
check(
  "Change Order list fail-closes through assertOwned after the scoped query",
  changeOrderListSrc.includes("access.assertOwned(request)"),
);

console.log("\nSTATIC — DRAFT-only create, dismiss, and duplicate guards");
const createFn = changeOrderActionSrc.slice(
  changeOrderActionSrc.indexOf("export async function createChangeOrder"),
  changeOrderActionSrc.indexOf("export async function updateChangeOrderTitle"),
);
check(
  "createChangeOrder creates DRAFT and never sets APPROVED/SENT",
  createFn.includes('status: "DRAFT"') &&
    !createFn.includes('status: "APPROVED"') &&
    !createFn.includes('status: "SENT"'),
);
check(
  "createChangeOrder never writes Estimate, Invoice, or Job approved scope",
  !changeOrderActionSrc.includes("prisma.estimate.") &&
    !changeOrderActionSrc.includes("prisma.invoice.") &&
    !changeOrderActionSrc.includes("approvedEstimateVersionId"),
);
check(
  "duplicate conversion is blocked by OPEN + existing changeOrderId",
  changeOrderActionSrc.includes("sourceRequest.changeOrderId") &&
    changeOrderActionSrc.includes("changeOrderId: null") &&
    changeOrderActionSrc.includes("That request has already been handled."),
);
check(
  "request and job must belong to the same authenticated business/job",
  changeOrderActionSrc.includes("jobId: job.id") &&
    changeOrderActionSrc.includes("...access.scope") &&
    changeOrderActionSrc.includes("sourceRequest.businessId !== job.businessId"),
);
check(
  "Dismiss confirmation is preserved and does not create a Change Order",
  requestListSrc.includes("DISMISS_ADDITIONAL_WORK_CONFIRM") &&
    requestListSrc.includes("This recorded status cannot be undone") &&
    requestListSrc.includes("Yes, dismiss") &&
    requestListSrc.includes("Keep request") &&
    requestListSrc.includes("setConfirmingDismiss(true)") &&
    requestListSrc.includes("dismissAdditionalWorkRequest") &&
    !requestListSrc.includes("Undo"),
);

try {
  const businessA = await prisma.business.create({
    data: { name: "Alpha Handoff", slug: "alpha-aw-co-handoff", tradeCode: "HANDYMAN" },
  });
  const businessB = await prisma.business.create({
    data: { name: "Beta Handoff", slug: "beta-aw-co-handoff", tradeCode: "HANDYMAN" },
  });
  const customerA = await prisma.customer.create({
    data: { businessId: businessA.id, name: "Alpha Customer", email: "alpha-handoff@example.com" },
  });
  const propertyA = await prisma.property.create({
    data: { businessId: businessA.id, customerId: customerA.id, addressLine1: "1 Handoff St" },
  });
  const customerB = await prisma.customer.create({
    data: { businessId: businessB.id, name: "Beta Customer", email: "beta-handoff@example.com" },
  });
  const propertyB = await prisma.property.create({
    data: { businessId: businessB.id, customerId: customerB.id, addressLine1: "9 Beta Handoff Ln" },
  });

  const ownerA = makeAccess(businessA.id, "OWNER");
  const ownerB = makeAccess(businessB.id, "OWNER");

  const jobA = await createApprovedJob(
    businessA.id,
    customerA.id,
    propertyA.id,
    1400,
    "Original approved hallway repair",
  );
  const jobA2 = await createApprovedJob(
    businessA.id,
    customerA.id,
    propertyA.id,
    500,
    "Second local job",
  );
  const jobB = await createApprovedJob(
    businessB.id,
    customerB.id,
    propertyB.id,
    900,
    "Beta original scope",
  );
  const originalVersionId = (
    await prisma.job.findUniqueOrThrow({ where: { id: jobA.id } })
  ).approvedEstimateVersionId;

  const deadbolt = await prisma.serviceCatalogItem.create({
    data: {
      businessId: businessA.id,
      name: "Digital Deadbolt Installation",
      pricingMode: "FIXED",
      price: new Prisma.Decimal("125.00"),
      category: "Doors & Locks",
      active: true,
    },
  });

  console.log("\nBEHAVIOR — Customer request displays recorded context");
  const customerRequest = await createCustomerAdditionalWorkRequest(prisma, {
    token: jobA.projectToken,
    catalogItemIds: [deadbolt.id],
    catalogQuantities: { [deadbolt.id]: 2 },
    notes: "Please add a digital deadbolt on the side door.",
  });
  check("customer request stored", customerRequest.ok === true);
  const storedCustomer = await prisma.additionalWorkRequest.findUniqueOrThrow({
    where: { id: customerRequest.ok ? customerRequest.requestId : "missing" },
    include: {
      items: {
        include: { serviceCatalogItem: { select: { name: true } } },
      },
    },
  });
  check("customer request source is CUSTOMER", storedCustomer.source === "CUSTOMER");
  check(
    "customer request keeps recorded description",
    storedCustomer.description === "Please add a digital deadbolt on the side door.",
  );
  check("customer request quantity 2 is recorded", storedCustomer.items[0]?.quantity === 2);
  check(
    "customer request service label is preserved",
    storedCustomer.items[0]?.serviceCatalogItem?.name === "Digital Deadbolt Installation",
  );
  check(
    "requestedWorkLabels keeps quantity × service label",
    requestedWorkLabels(storedCustomer).includes("2 × Digital Deadbolt Installation"),
  );
  check("customer request createdAt is recorded", storedCustomer.createdAt instanceof Date);

  console.log("\nBEHAVIOR — Employee request displays recorded context");
  const employeeRequest = await prisma.additionalWorkRequest.create({
    data: {
      businessId: businessA.id,
      jobId: jobA.id,
      description: "Homeowner asked on-site for a second coat of trim paint.",
      source: "EMPLOYEE",
    },
  });
  check("employee request source is EMPLOYEE", employeeRequest.source === "EMPLOYEE");
  check(
    "employee request keeps recorded description",
    employeeRequest.description === "Homeowner asked on-site for a second coat of trim paint.",
  );
  check("employee request createdAt is recorded", employeeRequest.createdAt instanceof Date);
  check(
    "employee request with no items does not invent service labels",
    requestedWorkLabels(employeeRequest).length === 0,
  );

  const beforeCustomerScope = resolveApprovedWorkOrderScope(await fetchJobForScope(jobA.id));
  const beforeCustomerTotal = resolveCurrentApprovedProjectTotal(
    beforeCustomerScope.total,
    await prisma.changeOrder.findMany({ where: { jobId: jobA.id } }),
  );
  const invoicesBefore = await prisma.invoice.count({ where: { jobId: jobA.id } });

  console.log("\nBEHAVIOR — Create Change Order from customer request stays DRAFT");
  const customerCo = await mirrorCreateChangeOrder(ownerA, {
    jobId: jobA.id,
    title: requestedWorkLabels(storedCustomer)[0] ?? storedCustomer.description,
    additionalWorkRequestId: storedCustomer.id,
  });
  check("customer request created a Change Order", Boolean(customerCo.changeOrder?.id));
  check("created Change Order is DRAFT", customerCo.changeOrder?.status === "DRAFT");
  check(
    "created Change Order was not auto-approved",
    customerCo.changeOrder?.approvedAt == null &&
      customerCo.changeOrder?.status !== "APPROVED",
  );
  const convertedCustomer = await prisma.additionalWorkRequest.findUniqueOrThrow({
    where: { id: storedCustomer.id },
  });
  check("request status is CONVERTED", convertedCustomer.status === "CONVERTED");
  check(
    "existing changeOrderId relation stores the handoff",
    convertedCustomer.changeOrderId === customerCo.changeOrder.id,
  );

  const customerLines = await prisma.lineItem.findMany({
    where: { changeOrderId: customerCo.changeOrder.id },
  });
  check(
    "catalog quantity 2 is preserved on the draft line",
    customerLines[0]?.quantity.toString() === "2",
  );
  check(
    "catalog service label is preserved on the draft line",
    customerLines[0]?.description === "Digital Deadbolt Installation",
  );
  check(
    "catalog draft prefill stays on the Change Order only (owner still prices/sends)",
    customerCo.changeOrder.status === "DRAFT",
  );

  console.log("\nBEHAVIOR — No estimate rewrite, invoice, or approved-total change");
  const afterCustomerJob = await prisma.job.findUniqueOrThrow({ where: { id: jobA.id } });
  check(
    "Job.approvedEstimateVersionId is unchanged",
    afterCustomerJob.approvedEstimateVersionId === originalVersionId,
  );
  const afterCustomerScope = resolveApprovedWorkOrderScope(await fetchJobForScope(jobA.id));
  check(
    "original approved estimate total is unchanged",
    afterCustomerScope.total.toString() === beforeCustomerScope.total.toString(),
  );
  const afterCustomerTotal = resolveCurrentApprovedProjectTotal(
    afterCustomerScope.total,
    await prisma.changeOrder.findMany({ where: { jobId: jobA.id } }),
  );
  check(
    "current approved project total ignores the DRAFT Change Order",
    afterCustomerTotal.toString() === beforeCustomerTotal.toString() &&
      afterCustomerTotal.toString() === "1400",
  );
  check(
    "no invoice was created by draft conversion",
    (await prisma.invoice.count({ where: { jobId: jobA.id } })) === invoicesBefore,
  );

  console.log("\nBEHAVIOR — Employee request also creates DRAFT with source link");
  const employeeCo = await mirrorCreateChangeOrder(ownerA, {
    jobId: jobA.id,
    title: employeeRequest.description.slice(0, 80),
    additionalWorkRequestId: employeeRequest.id,
  });
  check("employee request created a DRAFT Change Order", employeeCo.changeOrder?.status === "DRAFT");
  const convertedEmployee = await prisma.additionalWorkRequest.findUniqueOrThrow({
    where: { id: employeeRequest.id },
  });
  check(
    "employee request links through the existing changeOrderId relation",
    convertedEmployee.changeOrderId === employeeCo.changeOrder.id &&
      convertedEmployee.status === "CONVERTED",
  );
  const employeeLines = await prisma.lineItem.findMany({
    where: { changeOrderId: employeeCo.changeOrder.id },
  });
  check(
    "description-only employee request does not invent a price or line amount",
    employeeLines.length === 0 && employeeCo.changeOrder.total.toString() === "0",
  );

  const linkedForList = await loadLinkedChangeOrderSourceRequests(ownerA, {
    jobId: jobA.id,
    changeOrderIds: [customerCo.changeOrder.id, employeeCo.changeOrder.id],
  });
  check(
    "Change Order list can follow the relation for customer source context",
    linkedForList.some(
      (row) =>
        row.changeOrderId === customerCo.changeOrder.id && row.source === "CUSTOMER",
    ),
  );
  check(
    "Change Order list can follow the relation for employee source context",
    linkedForList.some(
      (row) =>
        row.changeOrderId === employeeCo.changeOrder.id &&
        row.source === "EMPLOYEE" &&
        row.description === employeeRequest.description,
    ),
  );
  check(
    "same-tenant source context is visible through the scoped ChangeOrderList query",
    linkedForList.length === 2 &&
      linkedForList.every((row) => row.businessId === businessA.id),
  );

  console.log("\nBEHAVIOR — Duplicate conversion is prevented");
  const duplicate = await mirrorCreateChangeOrder(ownerA, {
    jobId: jobA.id,
    title: "Duplicate conversion attempt",
    additionalWorkRequestId: storedCustomer.id,
  });
  check(
    "second conversion of the same OPEN-no-longer request is rejected",
    Boolean(duplicate.error) && !duplicate.changeOrder,
  );
  const changeOrdersFromCustomer = await prisma.changeOrder.count({
    where: {
      jobId: jobA.id,
      additionalWorkRequests: { some: { id: storedCustomer.id } },
    },
  });
  check("only one Change Order remains linked to the customer request", changeOrdersFromCustomer === 1);

  console.log("\nBEHAVIOR — Dismiss does not create a Change Order");
  const dismissRequest = await prisma.additionalWorkRequest.create({
    data: {
      businessId: businessA.id,
      jobId: jobA.id,
      description: "A request that will be dismissed.",
      source: "CUSTOMER",
    },
  });
  const changeOrderCountBeforeDismiss = await prisma.changeOrder.count({
    where: { jobId: jobA.id },
  });
  const dismissed = await mirrorDismissAdditionalWorkRequest(ownerA, dismissRequest.id);
  check("dismiss succeeded", !dismissed.error);
  const storedDismissed = await prisma.additionalWorkRequest.findUniqueOrThrow({
    where: { id: dismissRequest.id },
  });
  check("dismissed status is DISMISSED", storedDismissed.status === "DISMISSED");
  check("dismissed request has no changeOrderId", storedDismissed.changeOrderId === null);
  check(
    "dismiss created no Change Order",
    (await prisma.changeOrder.count({ where: { jobId: jobA.id } })) ===
      changeOrderCountBeforeDismiss,
  );
  const convertDismissed = await mirrorCreateChangeOrder(ownerA, {
    jobId: jobA.id,
    title: "Should not convert dismissed request",
    additionalWorkRequestId: dismissRequest.id,
  });
  check("dismissed request cannot silently generate a Change Order", Boolean(convertDismissed.error));

  console.log("\nBEHAVIOR — Tenant isolation");
  const foreignRequest = await prisma.additionalWorkRequest.create({
    data: {
      businessId: businessB.id,
      jobId: jobB.id,
      description: "Secret beta additional work",
      source: "CUSTOMER",
    },
  });
  let foreignRequestRejected = false;
  try {
    await mirrorCreateChangeOrder(ownerA, {
      jobId: jobA.id,
      title: "Cross-tenant conversion",
      additionalWorkRequestId: foreignRequest.id,
    });
  } catch {
    foreignRequestRejected = true;
  }
  check(
    "foreign request cannot create a Change Order on the local Job",
    foreignRequestRejected,
  );
  check(
    "foreign request remains OPEN and unlinked",
    (await prisma.additionalWorkRequest.findUniqueOrThrow({ where: { id: foreignRequest.id } }))
      .status === "OPEN" &&
      (await prisma.additionalWorkRequest.findUniqueOrThrow({ where: { id: foreignRequest.id } }))
        .changeOrderId === null,
  );

  const pairingRequest = await prisma.additionalWorkRequest.create({
    data: {
      businessId: businessA.id,
      jobId: jobA2.id,
      description: "Belongs to the other local job",
      source: "CUSTOMER",
    },
  });
  let pairingRejected = false;
  try {
    await mirrorCreateChangeOrder(ownerA, {
      jobId: jobA.id,
      title: "Mismatched job/request pairing",
      additionalWorkRequestId: pairingRequest.id,
    });
  } catch {
    pairingRejected = true;
  }
  check("foreign Job/request pairing is rejected", pairingRejected);
  check(
    "mismatched request stays OPEN on its own job",
    (await prisma.additionalWorkRequest.findUniqueOrThrow({ where: { id: pairingRequest.id } }))
      .status === "OPEN",
  );

  let foreignJobRejected = false;
  try {
    await mirrorCreateChangeOrder(ownerA, {
      jobId: jobB.id,
      title: "Foreign job",
      additionalWorkRequestId: foreignRequest.id,
    });
  } catch {
    foreignJobRejected = true;
  }
  check("foreign jobId is rejected by tenant scope", foreignJobRejected);

  const secretBetaDescription = "SECRET-BETA-SOURCE-CONTEXT-MUST-NOT-LEAK";
  await prisma.additionalWorkRequest.update({
    where: { id: foreignRequest.id },
    data: {
      description: secretBetaDescription,
      jobId: jobA.id,
      changeOrderId: customerCo.changeOrder.id,
    },
  });
  const manipulatedIds = await loadLinkedChangeOrderSourceRequests(ownerA, {
    jobId: jobA.id,
    changeOrderIds: [
      customerCo.changeOrder.id,
      employeeCo.changeOrder.id,
      foreignRequest.id,
    ],
  });
  check(
    "foreign-tenant AdditionalWorkRequest cannot appear in ChangeOrderList even if IDs are manipulated",
    manipulatedIds.every((row) => row.businessId === businessA.id) &&
      !manipulatedIds.some((row) => row.description === secretBetaDescription) &&
      !manipulatedIds.some((row) => row.id === foreignRequest.id),
  );
  const mismatchedJobQuery = await loadLinkedChangeOrderSourceRequests(ownerA, {
    jobId: jobB.id,
    changeOrderIds: [customerCo.changeOrder.id],
  });
  check(
    "same-tenant access plus a foreign jobId still returns no source context",
    mismatchedJobQuery.length === 0,
  );

  console.log("\nBEHAVIOR — Existing Change Order lifecycle still works");
  const lifecycle = await mirrorCreateChangeOrder(ownerA, {
    jobId: jobA.id,
    title: "Standalone lifecycle draft",
  });
  check("standalone Change Order starts DRAFT", lifecycle.changeOrder?.status === "DRAFT");
  await mirrorAddChangeOrderLineItem(ownerA, lifecycle.changeOrder.id, {
    description: "Extra paint",
    quantity: new Prisma.Decimal(1),
    unitPrice: new Prisma.Decimal(75),
  });
  const afterLine = await prisma.changeOrder.findUniqueOrThrow({
    where: { id: lifecycle.changeOrder.id },
  });
  check("DRAFT line item updates only the Change Order total", afterLine.total.toString() === "75");
  const sent = await mirrorSendChangeOrder(ownerA, lifecycle.changeOrder.id);
  check("DRAFT can still be sent", !sent.error);
  const afterSend = await prisma.changeOrder.findUniqueOrThrow({
    where: { id: lifecycle.changeOrder.id },
  });
  check("sent Change Order is SENT, not APPROVED", afterSend.status === "SENT");
  const totalWhileSent = resolveCurrentApprovedProjectTotal(
    (await fetchJobForScope(jobA.id)).approvedEstimateVersion.total,
    await prisma.changeOrder.findMany({ where: { jobId: jobA.id } }),
  );
  check(
    "SENT Change Order still does not change the approved project total",
    totalWhileSent.toString() === "1400",
  );

  await prisma.changeOrder.update({
    where: { id: lifecycle.changeOrder.id },
    data: { status: "APPROVED", approvedAt: new Date() },
  });
  const totalAfterApprove = resolveCurrentApprovedProjectTotal(
    (await fetchJobForScope(jobA.id)).approvedEstimateVersion.total,
    await prisma.changeOrder.findMany({ where: { jobId: jobA.id } }),
  );
  check(
    "approved project total moves only after canonical Change Order approval",
    totalAfterApprove.toString() === "1475",
  );

  check(
    "handoff and lifecycle left the in-progress job without an invoice",
    (await prisma.invoice.count({ where: { jobId: jobA.id } })) === 0,
  );

  console.log(
    failures === 0
      ? "\nAll additional-work change-order handoff checks passed."
      : `\n${failures} additional-work change-order handoff check(s) failed.`,
  );
} finally {
  await prisma.$disconnect();
  const cleanup = new PrismaClient({ datasourceUrl: baseUrl });
  try {
    await cleanup.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${testDbName}"`);
  } finally {
    await cleanup.$disconnect();
  }
}

process.exit(failures === 0 ? 0 : 1);
