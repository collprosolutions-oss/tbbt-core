/**
 * OWNER-only offline purchase-order supplier handoff CSV proofs.
 *
 * Covers authorization, tenant isolation, recorded supplier / line /
 * historical-price / status content, spreadsheet formula escaping, and
 * that the download stays a read. It does not place a retailer order,
 * call a supplier API, scrape prices, record a stock receipt, or send
 * a customer message.
 *
 * Run with:
 *   npm run test:purchase-order-export
 */
import { register } from "node:module";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  assertLocalDatabaseUrl,
  openDisposableTestDatabase,
} from "./disposable-test-database.mjs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { ForbiddenError } = await import("@/lib/authorization");
const { assertBusinessRecord, businessScope } = await import("@/lib/access-scope");
const {
  PURCHASE_ORDER_EXPORT_CONTRACT,
  PURCHASE_ORDER_EXPORT_HEADERS,
  PURCHASE_ORDER_EXPORT_KIND,
  PURCHASE_ORDER_EXPORT_NOTICE,
  PURCHASE_ORDER_EXPORT_PRICE_READ_LIMIT,
  PURCHASE_ORDER_EXPORT_VERSION,
  PurchaseOrderExportError,
  boundExportRead,
  buildPurchaseOrderSupplierHandoff,
  canExportPurchaseOrderSupplierHandoff,
  purchaseOrderSupplierHandoffCsv,
  purchaseOrderSupplierHandoffFilename,
  runPurchaseOrderSupplierHandoffDownload,
} = await import("@/lib/purchase-order-export");
const { neutralizeCsvFormulaPrefix, toCsvCell } = await import("@/lib/zip-store");

const baseUrl = process.env.DATABASE_URL;
if (!baseUrl) {
  console.error("DATABASE_URL must be set to run this check.");
  process.exit(1);
}
assertLocalDatabaseUrl(baseUrl, "purchase-order-export disposable database");

const session = await openDisposableTestDatabase({
  databaseUrl: baseUrl,
  namePrefix: "tbbt_po_supplier_handoff",
  pushSchema: true,
});
const prisma = session.prisma;

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

function makeAccess(businessId, role, membershipId) {
  return {
    businessId,
    workspace: {
      role,
      membership: { id: membershipId },
      business: { id: businessId, name: "PO Export Tenant" },
    },
    scope: businessScope(businessId),
    assertOwned(record) {
      return assertBusinessRecord(record, businessId);
    },
    assertAttachable(record) {
      return assertBusinessRecord(record, businessId);
    },
  };
}

async function expectRejects(label, fn, isExpected) {
  try {
    await fn();
    check(label, false);
  } catch (error) {
    check(label, isExpected(error));
  }
}

function parseCsv(text) {
  const src = text.replace(/\r\n/g, "\n");
  const lines = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i += 1;
          continue;
        }
        inQuotes = false;
        continue;
      }
      cell += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      lines.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += ch;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    lines.push(row);
  }
  if (lines.length && lines[lines.length - 1].every((value) => value === "")) {
    lines.pop();
  }
  const headers = lines[0] ?? [];
  const records = lines.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])),
  );
  return { headers, records };
}

const accessSrc = readRepo("src/lib/purchase-order-export/access.ts");
const buildSrc = readRepo("src/lib/purchase-order-export/build.ts");
const contractSrc = readRepo("src/lib/purchase-order-export/contract.ts");
const httpSrc = readRepo("src/lib/purchase-order-export/http.ts");
const routeSrc = readRepo(
  "src/app/(app)/materials/purchase-orders/[purchaseOrderId]/supplier-handoff/download/route.ts",
);
const cardSrc = readRepo("src/components/materials/purchase-list-card.tsx");
const jobPageSrc = readRepo("src/app/(app)/jobs/[jobId]/page.tsx");
const estimatePageSrc = readRepo("src/app/(app)/estimates/[estimateId]/page.tsx");
const navSrc = readRepo("src/lib/nav.ts");
const settingsSrc = readRepo("src/components/settings/settings-workspace.tsx");
const authSrc = readRepo("src/lib/authorization.ts");
const schemaSrc = readRepo("prisma/schema.prisma");
const packageSrc = readRepo("package.json");
const adapterSrc = readRepo("src/lib/materials/adapter.ts");

const OFFLINE_FORBIDDEN = [
  "getSupplierCommerceAdapter",
  "quotePrice",
  "createCartHandoff",
  "lookupProduct",
  "checkAvailability",
  "cheerio",
  "puppeteer",
  "recordPurchaseOrderReceipt",
  "sendMessage",
  "resend",
  "twilio",
  "scrape",
  "$executeRaw",
  "CREATE TABLE",
  "ALTER TABLE",
];

console.log("\nSTATIC — inspect existing PO / supplier flow, then add offline CSV handoff");
check(
  "Existing recorded PO, supplier, line, and price-history models remain the source of truth",
  schemaSrc.includes("model MaterialPurchaseOrder") &&
    schemaSrc.includes("model MaterialPurchaseOrderItem") &&
    schemaSrc.includes("model Supplier") &&
    schemaSrc.includes("model MaterialPriceHistory") &&
    !schemaSrc.includes("PurchaseOrderExport") &&
    !schemaSrc.includes("SupplierHandoff"),
);
check(
  "OWNER may export; ADMIN and MEMBER cannot",
  canExportPurchaseOrderSupplierHandoff("OWNER") &&
    !canExportPurchaseOrderSupplierHandoff("ADMIN") &&
    !canExportPurchaseOrderSupplierHandoff("MEMBER"),
);
check(
  "Contract is versioned offline supplier handoff v1",
  PURCHASE_ORDER_EXPORT_CONTRACT === "tbbt.purchase-order-supplier-handoff.v1" &&
    PURCHASE_ORDER_EXPORT_VERSION === 1 &&
    PURCHASE_ORDER_EXPORT_KIND === "OFFLINE_SUPPLIER_HANDOFF" &&
    PURCHASE_ORDER_EXPORT_PRICE_READ_LIMIT === 40 &&
    contractSrc.includes("not a retailer order") &&
    PURCHASE_ORDER_EXPORT_NOTICE.includes("does not place a retailer order"),
);
check(
  "Builder scopes the PO, supplier, lines, and price history by access.businessId",
  buildSrc.includes("where: { id: purchaseOrderId, businessId }") &&
    buildSrc.includes("where: { businessId }") &&
    buildSrc.includes("access.assertOwned(order)") &&
    buildSrc.includes("access.assertOwned(order.supplier)") &&
    buildSrc.includes("access.assertOwned(item)") &&
    buildSrc.includes("access.assertOwned(row)"),
);
check(
  "Export is a read of recorded history and never talks to a supplier adapter",
  OFFLINE_FORBIDDEN.every((marker) => !buildSrc.includes(marker) && !httpSrc.includes(marker)) &&
    !buildSrc.includes("prisma.materialPurchaseOrder.update") &&
    !buildSrc.includes("prisma.materialPurchaseOrderReceipt.create") &&
    adapterSrc.includes('connectionState: "DISCONNECTED"'),
);
check(
  "CSV uses shared formula neutralization including tab and CR",
  buildSrc.includes("toCsv(") &&
    buildSrc.includes("PURCHASE_ORDER_EXPORT_HEADERS") &&
    toCsvCell("=HYPERLINK(\"https://example.invalid\",\"x\")") ===
      "'=HYPERLINK(\"https://example.invalid\",\"x\")" &&
    neutralizeCsvFormulaPrefix("+SUM(1,1)") === "'+SUM(1,1)" &&
    neutralizeCsvFormulaPrefix("@cmd") === "'@cmd" &&
    neutralizeCsvFormulaPrefix("\t=1+1") === "'\t=1+1" &&
    neutralizeCsvFormulaPrefix("\r=1+1") === "'\r=1+1" &&
    neutralizeCsvFormulaPrefix("6.47") === "6.47",
);
check(
  "Dedicated download route stays OWNER-gated, attachment-only, and uncached",
  routeSrc.includes("runPurchaseOrderSupplierHandoffDownload") &&
    routeSrc.includes("requireBusinessAccess") &&
    routeSrc.includes("text/csv") &&
    routeSrc.includes("Cache-Control") &&
    httpSrc.includes("canExportPurchaseOrderSupplierHandoff"),
);
check(
  "OWNER download control is on the existing PO card, not global nav or Settings",
  cardSrc.includes("Download supplier handoff CSV") &&
    cardSrc.includes("canExportSupplierHandoff") &&
    jobPageSrc.includes("canExportSupplierHandoff={access.workspace.role === \"OWNER\"}") &&
    estimatePageSrc.includes("canExportSupplierHandoff={access.workspace.role === \"OWNER\"}") &&
    !navSrc.includes("supplier-handoff") &&
    !settingsSrc.includes("supplier-handoff"),
);
check(
  "No new capability, schema table, or live-order claim",
  !authSrc.includes("EXPORT_PURCHASE_ORDER") &&
    accessSrc.includes('return role === "OWNER"') &&
    !buildSrc.includes("placesRetailerOrder: true") &&
    !contractSrc.includes("live synchronization is enabled") &&
    packageSrc.includes("test:purchase-order-export") &&
    boundExportRead(["a", "b", "c"], 2).truncated === true,
);

async function seedTenant(label, formula = false) {
  const user = await prisma.user.create({
    data: { name: `${label} Owner`, email: `${label}-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const adminUser = await prisma.user.create({
    data: { name: `${label} Admin`, email: `${label}-admin-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const memberUser = await prisma.user.create({
    data: { name: `${label} Member`, email: `${label}-member-${randomUUID()}@example.com`, passwordHash: "x" },
  });
  const business = await prisma.business.create({
    data: { name: `${label} Materials`, slug: `${label}-${randomUUID().slice(0, 8)}` },
  });
  const ownerMem = await prisma.membership.create({
    data: { businessId: business.id, userId: user.id, role: "OWNER" },
  });
  const adminMem = await prisma.membership.create({
    data: { businessId: business.id, userId: adminUser.id, role: "ADMIN" },
  });
  const memberMem = await prisma.membership.create({
    data: { businessId: business.id, userId: memberUser.id, role: "MEMBER" },
  });
  const supplierName = formula
    ? '=HYPERLINK("https://evil.example","x")'
    : `${label} Building Supply`;
  const supplier = await prisma.supplier.create({
    data: {
      businessId: business.id,
      name: supplierName,
      contactName: formula ? "+SUM(1,1)" : `${label} Counter`,
      contactPhone: "555-0100",
      contactEmail: `${label}@vendor.example`,
      accountReference: formula ? "@cmd" : `${label}-ACCT`,
      locationDescription: formula ? "\t=1+1" : `${label} yard`,
    },
  });
  const material = await prisma.materialCatalogItem.create({
    data: {
      businessId: business.id,
      name: formula ? "-CMD lumber" : `${label} 2x4`,
      normalizedName: formula ? "cmd lumber" : `${label} 2x4`.toLowerCase(),
      sku: `${label}-SKU`,
      unit: "ea",
      lastKnownCost: "3.50",
    },
  });
  const olderPrice = await prisma.materialPriceHistory.create({
    data: {
      businessId: business.id,
      materialId: material.id,
      supplierId: supplier.id,
      unit: "ea",
      price: "3.25",
      observedAt: new Date("2026-01-15T12:00:00.000Z"),
      source: "PURCHASE",
    },
  });
  const latestPrice = await prisma.materialPriceHistory.create({
    data: {
      businessId: business.id,
      materialId: material.id,
      supplierId: supplier.id,
      unit: "ea",
      price: "3.50",
      observedAt: new Date("2026-03-01T12:00:00.000Z"),
      source: "OWNER_ENTRY",
    },
  });
  const customer = await prisma.customer.create({
    data: { businessId: business.id, name: `${label} Customer` },
  });
  const estimate = await prisma.estimate.create({
    data: {
      businessId: business.id,
      customerId: customer.id,
      status: "DRAFT",
      publicToken: randomUUID(),
    },
  });
  const list = await prisma.materialPurchaseList.create({
    data: { businessId: business.id, estimateId: estimate.id },
  });
  const listItem = await prisma.materialPurchaseListItem.create({
    data: {
      businessId: business.id,
      purchaseListId: list.id,
      materialId: material.id,
      supplierId: supplier.id,
      name: formula ? "+SUM(1,1) studs" : `${label} studs`,
      quantityNeeded: "12",
      unit: "ea",
      plannedUnitCost: "3.50",
      status: "PLANNED",
    },
  });
  const order = await prisma.materialPurchaseOrder.create({
    data: {
      businessId: business.id,
      purchaseListId: list.id,
      supplierId: supplier.id,
      status: "ORDERED_EXTERNALLY",
      notes: formula ? "=cmd|export" : `${label} pickup Friday`,
      orderedAt: new Date("2026-04-02T15:00:00.000Z"),
    },
  });
  const line = await prisma.materialPurchaseOrderItem.create({
    data: {
      businessId: business.id,
      purchaseOrderId: order.id,
      purchaseListItemId: listItem.id,
      quantity: "12",
      unitCost: "3.50",
    },
  });
  return {
    business,
    supplier,
    material,
    olderPrice,
    latestPrice,
    order,
    line,
    listItem,
    owner: makeAccess(business.id, "OWNER", ownerMem.id),
    admin: makeAccess(business.id, "ADMIN", adminMem.id),
    member: makeAccess(business.id, "MEMBER", memberMem.id),
  };
}

try {
  const tenantA = await seedTenant("alpha", true);
  const tenantB = await seedTenant("beta", false);

  console.log("\nTEST — OWNER export of one recorded PO");
  const beforeA = {
    receipts: await prisma.materialPurchaseOrderReceipt.count({ where: { businessId: tenantA.business.id } }),
    orders: await prisma.materialPurchaseOrder.count({ where: { businessId: tenantA.business.id } }),
    history: await prisma.materialPriceHistory.count({ where: { businessId: tenantA.business.id } }),
    payments: await prisma.payment.count({ where: { businessId: tenantA.business.id } }),
  };
  const document = await buildPurchaseOrderSupplierHandoff(prisma, tenantA.owner, {
    purchaseOrderId: tenantA.order.id,
  });
  const csv = purchaseOrderSupplierHandoffCsv(document);
  const parsed = parseCsv(csv);
  const row = parsed.records[0];

  check(
    "Document is the offline v1 contract for this one PO",
    document.contract === PURCHASE_ORDER_EXPORT_CONTRACT &&
      document.kind === PURCHASE_ORDER_EXPORT_KIND &&
      document.authorization.role === "OWNER" &&
      document.authorization.businessId === tenantA.business.id &&
      document.purchaseOrder.id === tenantA.order.id &&
      document.purchaseOrder.status === "ORDERED_EXTERNALLY" &&
      document.purchaseOrder.statusLabel === "Ordered externally" &&
      document.limits.placesRetailerOrder === false &&
      document.limits.callsSupplierApi === false &&
      document.limits.scrapesPrices === false &&
      document.limits.recordsStockReceipt === false &&
      document.limits.sendsCustomerMessage === false,
  );
  check(
    "Supplier, line quantity, recorded cost, and historical prices are present",
    document.supplier?.id === tenantA.supplier.id &&
      document.lines.length === 1 &&
      document.lines[0].quantity === "12" &&
      Number(document.lines[0].recordedUnitCost) === 3.5 &&
      Number(document.lines[0].extendedCost) === 42 &&
      document.lines[0].sku === "alpha-SKU" &&
      document.lines[0].historicalPrices.length === 2 &&
      Number(document.lines[0].historicalPrices[0].price) === 3.5 &&
      document.lines[0].historicalPrices[0].source === "OWNER_ENTRY" &&
      Number(document.lines[0].historicalPrices[1].price) === 3.25 &&
      document.lines[0].historicalPrices[1].source === "PURCHASE",
  );
  check(
    "CSV headers and one line row include status, supplier, qty, and history",
    parsed.headers.length === PURCHASE_ORDER_EXPORT_HEADERS.length &&
      PURCHASE_ORDER_EXPORT_HEADERS.every((header, index) => parsed.headers[index] === header) &&
      parsed.records.length === 1 &&
      row["Purchase Order ID"] === tenantA.order.id &&
      row.Status === "ORDERED_EXTERNALLY" &&
      row["Status Label"] === "Ordered externally" &&
      row.Quantity === "12" &&
      Number(row["Latest Historical Price"]) === 3.5 &&
      row["Latest Historical Source"] === "OWNER_ENTRY" &&
      row["Historical Prices"].includes("3.25") &&
      row["Document Kind"] === PURCHASE_ORDER_EXPORT_KIND &&
      row["Document Notice"] === PURCHASE_ORDER_EXPORT_NOTICE &&
      csv.endsWith("\n"),
  );
  check(
    "Formula-like supplier and line text is prefixed so spreadsheet cells stay literal",
    row["Supplier Name"] === `'=HYPERLINK("https://evil.example","x")` &&
      row["Supplier Contact Name"] === "'+SUM(1,1)" &&
      row["Supplier Account Reference"] === "'@cmd" &&
      row["Supplier Location"] === "'\t=1+1" &&
      row["Line Name"] === "'+SUM(1,1) studs" &&
      row.Quantity === "12" &&
      Number(row["Recorded Unit Cost"]) === 3.5,
  );
  check(
    "Filename is a handoff CSV for this PO",
    purchaseOrderSupplierHandoffFilename(document).endsWith("-supplier-handoff.csv") &&
      purchaseOrderSupplierHandoffFilename(document).startsWith("po-"),
  );

  const downloaded = await runPurchaseOrderSupplierHandoffDownload(prisma, tenantA.owner, {
    purchaseOrderId: tenantA.order.id,
  });
  check(
    "Download helper returns the same uncached CSV attachment payload",
    downloaded.ok === true &&
      downloaded.status === 200 &&
      downloaded.contentType === "text/csv; charset=utf-8" &&
      downloaded.body === csv &&
      downloaded.filename === purchaseOrderSupplierHandoffFilename(document),
  );

  const afterA = {
    receipts: await prisma.materialPurchaseOrderReceipt.count({ where: { businessId: tenantA.business.id } }),
    orders: await prisma.materialPurchaseOrder.count({ where: { businessId: tenantA.business.id } }),
    history: await prisma.materialPriceHistory.count({ where: { businessId: tenantA.business.id } }),
    payments: await prisma.payment.count({ where: { businessId: tenantA.business.id } }),
  };
  check(
    "Export does not create a receipt, payment, extra PO, or scraped price row",
    afterA.receipts === beforeA.receipts &&
      afterA.orders === beforeA.orders &&
      afterA.history === beforeA.history &&
      afterA.payments === beforeA.payments,
  );

  console.log("\nTEST — role and tenant isolation");
  await expectRejects(
    "ADMIN cannot export the supplier handoff",
    () =>
      buildPurchaseOrderSupplierHandoff(prisma, tenantA.admin, {
        purchaseOrderId: tenantA.order.id,
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectRejects(
    "MEMBER cannot export the supplier handoff",
    () =>
      buildPurchaseOrderSupplierHandoff(prisma, tenantA.member, {
        purchaseOrderId: tenantA.order.id,
      }),
    (error) => error instanceof ForbiddenError,
  );
  await expectRejects(
    "OWNER cannot export another tenant's purchase order",
    () =>
      buildPurchaseOrderSupplierHandoff(prisma, tenantA.owner, {
        purchaseOrderId: tenantB.order.id,
      }),
    (error) =>
      error instanceof PurchaseOrderExportError &&
      error.code === "NOT_FOUND" &&
      error.status === 404,
  );
  const adminDownload = await runPurchaseOrderSupplierHandoffDownload(prisma, tenantA.admin, {
    purchaseOrderId: tenantA.order.id,
  });
  const crossDownload = await runPurchaseOrderSupplierHandoffDownload(prisma, tenantA.owner, {
    purchaseOrderId: tenantB.order.id,
  });
  check(
    "HTTP helper hides cross-tenant POs as not found and forbids ADMIN",
    adminDownload.ok === false &&
      adminDownload.status === 403 &&
      crossDownload.ok === false &&
      crossDownload.status === 404 &&
      crossDownload.error === "That purchase order was not found in this workspace.",
  );

  const documentB = await buildPurchaseOrderSupplierHandoff(prisma, tenantB.owner, {
    purchaseOrderId: tenantB.order.id,
  });
  const csvB = purchaseOrderSupplierHandoffCsv(documentB);
  check(
    "Each tenant only sees its own supplier, lines, and historical prices",
    documentB.supplier?.id === tenantB.supplier.id &&
      documentB.lines[0].sku === "beta-SKU" &&
      !csv.includes("beta-SKU") &&
      !csv.includes("beta Building Supply") &&
      !csvB.includes("alpha-SKU") &&
      !csvB.includes("evil.example") &&
      !document.lines.some((line) => line.historicalPrices.some((price) => price.id === tenantB.latestPrice.id)) &&
      !documentB.lines.some((line) => line.historicalPrices.some((price) => price.id === tenantA.latestPrice.id)),
  );

  await expectRejects(
    "Blank purchase-order id is rejected",
    () => buildPurchaseOrderSupplierHandoff(prisma, tenantA.owner, { purchaseOrderId: "   " }),
    (error) => error instanceof PurchaseOrderExportError && error.code === "INVALID",
  );
  const missing = await runPurchaseOrderSupplierHandoffDownload(prisma, tenantA.owner, {
    purchaseOrderId: randomUUID(),
  });
  check(
    "Unknown same-tenant id is not found",
    missing.ok === false && missing.status === 404,
  );
} catch (error) {
  failures += 1;
  console.error("FAIL - unexpected purchase-order export test error");
  console.error(error);
} finally {
  await session.cleanup();
}

if (failures > 0) {
  console.error(`\nPurchase-order supplier handoff check failed: ${failures} issue(s).`);
  process.exit(1);
}

console.log("\nAll purchase-order supplier handoff checks passed.");
