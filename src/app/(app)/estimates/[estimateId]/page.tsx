import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Prisma } from "@prisma/client";
import { AddCatalogLineForm } from "@/components/estimates/add-catalog-line-form";
import { AddCustomLineForm } from "@/components/estimates/add-custom-line-form";
import { ClearDraftEstimateButton } from "@/components/estimates/clear-draft-estimate-button";
import { CopyEstimateLinkButton } from "@/components/estimates/copy-estimate-link-button";
import { EditEstimateButton } from "@/components/estimates/edit-estimate-button";
import { EmailEstimateButton } from "@/components/estimates/email-estimate-button";
import { EstimateVersionHistory } from "@/components/estimates/estimate-version-history";
import { CalculatorBreakdown } from "@/components/estimates/calculator-breakdown";
import {
  EditLineIncludedWorkForm,
  SaveLineForReuseForm,
} from "@/components/estimates/draft-line-scope-forms";
import { EstimateCustomerPolicies } from "@/components/estimates/customer-policy-display";
import { IncludedWorkDisplay } from "@/components/estimates/included-work-display";
import { OverrideLinePriceForm } from "@/components/estimates/override-line-price-form";
import { PriceRequiredLineForm } from "@/components/estimates/price-required-line-form";
import { VariableScopeCalculatorForm } from "@/components/estimates/variable-scope-calculator-form";
import { VariableScopeDefinitionForm } from "@/components/estimates/variable-scope-definition-form";
import { MaterialTakeoffForm } from "@/components/estimates/material-takeoff-form";
import { RemoveLineItemButton } from "@/components/estimates/remove-line-item-button";
import { SendEstimateButton } from "@/components/estimates/send-estimate-button";
import { WaiveLaborMinimumButton } from "@/components/estimates/waive-labor-minimum-button";
import { CreateJobButton } from "@/components/jobs/create-job-button";
import { PageContainer } from "@/components/page-container";
import { PageHeader } from "@/components/page-header";
import { RecordNav } from "@/components/record-nav";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { requireManagementPageAccess } from "@/lib/access";
import { formatAddress, formatMoney } from "@/lib/format";
import { isUsableEmail } from "@/lib/mail";
import { formatCatalogPriceLabel } from "@/lib/pricing-mode";
import { prisma } from "@/lib/prisma";
import {
  CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID,
  DECORATIVE_WALL_PANELING_CALCULATOR_ID,
  findCatalogCalculatorDefinition,
  formCalculatorInputs,
  resolveCalculatorId,
  resolveCalculatorRatesForForm,
  templateForCalculator,
} from "@/lib/estimate-calculators";
import {
  catalogCalculatorDefinition,
  catalogScopeText,
  lineCalculatorSnapshot,
  lineCustomerPolicies,
  lineItemIncludedWork,
  lineItemTitle,
  lineMaterialTakeoff,
  lineMaterialTakeoffSource,
} from "@/lib/estimate-line-scope";
import {
  customQuoteDisplayDescription,
  isUnpricedCustomQuoteDraftLine,
} from "@/lib/request-estimate-draft";
import { requestedWorkLabels } from "@/lib/service-request-work";
import { RequestIntakeContext } from "@/components/estimates/request-intake-context";
import {
  formatWorkAreaIntakeLabels,
  parseWorkAreaIntake,
  requestNotesText,
} from "@/lib/work-area-intake";
import {
  ownerVisibleRequestMeasurements,
  ownerVisibleRequestPhotos,
  toStoredIntakeMeasurement,
} from "@/lib/intake-quote-handoff";
import {
  pickIntakeMeasurementForLine,
  suggestTakeoffInputs,
  suggestedTakeoffType,
} from "@/lib/material-takeoff/measurements";

export const metadata: Metadata = {
  title: "Estimate",
};

export default async function EstimateBuilderPage({
  params,
}: {
  params: Promise<{ estimateId: string }>;
}) {
  const { estimateId } = await params;
  const access = await requireManagementPageAccess();

  const estimate = await prisma.estimate.findFirst({
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
      serviceRequest: {
        select: {
          id: true,
          description: true,
          summary: true,
          serviceCatalogItem: { select: { name: true } },
          items: {
            orderBy: { sortOrder: "asc" },
            select: {
              customDescription: true,
              serviceCatalogItem: { select: { id: true, name: true } },
            },
          },
          photos: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              businessId: true,
              serviceRequestId: true,
              url: true,
              storedAssetId: true,
              storedAsset: {
                select: {
                  mimeType: true,
                  originalFilename: true,
                  visibility: true,
                  category: true,
                  status: true,
                  publicPath: true,
                },
              },
            },
          },
          measurements: {
            orderBy: { createdAt: "asc" },
            select: {
              id: true,
              businessId: true,
              serviceRequestId: true,
              source: true,
              width: true,
              height: true,
              length: true,
              quantity: true,
              unit: true,
              serviceRequestItem: {
                select: {
                  customDescription: true,
                  serviceCatalogItemId: true,
                  serviceCatalogItem: { select: { name: true } },
                },
              },
            },
          },
        },
      },
      jobs: { select: { id: true }, take: 1, orderBy: { createdAt: "asc" } },
      lineItems: { orderBy: { createdAt: "asc" } },
      versions: {
        orderBy: { versionNumber: "desc" },
        select: {
          id: true,
          versionNumber: true,
          total: true,
          sentAt: true,
          approvedAt: true,
        },
      },
    },
  });

  if (!estimate) {
    notFound();
  }
  access.assertOwned(estimate);

  const laborSubtotal = estimate.lineItems
    .filter((item) => item.type === "LABOR")
    .reduce((sum, item) => sum.add(item.total), new Prisma.Decimal(0));
  const materialSubtotal = estimate.lineItems
    .filter((item) => item.type === "MATERIAL")
    .reduce((sum, item) => sum.add(item.total), new Prisma.Decimal(0));
  const otherSubtotal = estimate.lineItems
    .filter((item) => item.type === "OTHER")
    .reduce((sum, item) => sum.add(item.total), new Prisma.Decimal(0));
  const business = access.workspace.business;
  const isDraft = estimate.status === "DRAFT";
  const isSent = estimate.status === "SENT";
  const isApproved = estimate.status === "APPROVED";
  const customerEmail = estimate.customer?.email ?? "";
  const hasCustomerEmail = isUsableEmail(customerEmail);
  const needsCustomQuotePrices = estimate.lineItems.some(isUnpricedCustomQuoteDraftLine);
  const fromCustomerRequest = Boolean(estimate.serviceRequestId);
  const intakePhotos = ownerVisibleRequestPhotos({
    businessId: estimate.businessId,
    serviceRequestId: estimate.serviceRequestId,
    photos: estimate.serviceRequest?.photos ?? [],
  });
  const intakeMeasurements = ownerVisibleRequestMeasurements({
    businessId: estimate.businessId,
    serviceRequestId: estimate.serviceRequestId,
    measurements: estimate.serviceRequest?.measurements ?? [],
  });
  const storedIntakeMeasurements = (estimate.serviceRequest?.measurements ?? [])
    .filter(
      (row) =>
        row.businessId === estimate.businessId &&
        row.serviceRequestId === estimate.serviceRequestId,
    )
    .map((row) => toStoredIntakeMeasurement(row));

  const catalogItems = await prisma.serviceCatalogItem.findMany({
    where: { ...access.scope, active: true },
    orderBy: { name: "asc" },
  });

  return (
    <PageContainer>
      <PageHeader
        title={estimate.customer?.name ?? "Customer"}
        description={
          <div className="flex flex-wrap items-center gap-2">
            <span>Estimate</span>
            <StatusBadge status={estimate.status} />
            <span>{formatMoney(estimate.total)}</span>
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <p>
            Customer view:{" "}
            <Link
              href={`/e/${estimate.publicToken}`}
              className="underline underline-offset-4"
            >
              /e/{estimate.publicToken}
            </Link>
          </p>
          <Button asChild size="sm" variant="outline">
            <Link href={`/estimates/${estimate.id}/print`}>Preview Estimate</Link>
          </Button>
          <Button asChild size="sm" variant="outline">
            <a href={`/estimates/${estimate.id}/pdf`}>Download PDF</a>
          </Button>
          {isSent || isApproved ? (
            <CopyEstimateLinkButton publicToken={estimate.publicToken} />
          ) : null}
        </div>
        {isSent ? (
          <p className="mt-2 text-sm text-foreground">
            This is the estimate currently presented to the customer. Editing
            returns it to draft, and you must send it again before they can
            approve.
          </p>
        ) : null}
        {isApproved ? (
          <p className="mt-2 text-sm text-muted-foreground">
            This estimate is approved and cannot be edited.
          </p>
        ) : null}
        {estimate.serviceRequestId ? (
          <div className="mt-2 space-y-1 text-sm text-foreground">
            {(() => {
              const tasks = estimate.serviceRequest
                ? requestedWorkLabels(estimate.serviceRequest)
                : [];
              if (tasks.length === 0) return null;
              return (
                <div>
                  <p className="font-medium">Requested work</p>
                  <ul className="list-disc pl-5">
                    {tasks.map((task) => (
                      <li key={task}>{task}</li>
                    ))}
                  </ul>
                  <p className="mt-1 text-muted-foreground">
                    Customer request is context for this draft.
                  </p>
                </div>
              );
            })()}
            {requestNotesText(estimate.serviceRequest?.description) ? (
              <p>{requestNotesText(estimate.serviceRequest?.description)}</p>
            ) : null}
            {(() => {
              const workAreaLabels = formatWorkAreaIntakeLabels(
                parseWorkAreaIntake(estimate.serviceRequest?.description),
                Object.fromEntries(
                  (estimate.serviceRequest?.items ?? []).flatMap((item) =>
                    item.serviceCatalogItem
                      ? [[item.serviceCatalogItem.id, item.serviceCatalogItem.name]]
                      : [],
                  ),
                ),
              );
              if (workAreaLabels.length === 0) return null;
              return (
                <div className="mt-2">
                  <p className="font-medium">Customer work-area answers</p>
                  <ul className="list-disc pl-5">
                    {workAreaLabels.map((label) => (
                      <li key={label}>{label}</li>
                    ))}
                  </ul>
                </div>
              );
            })()}
            <RequestIntakeContext photos={intakePhotos} measurements={intakeMeasurements} />
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">Manual estimate</p>
        )}
        <p className="mt-2 text-sm text-muted-foreground">
          Service address:{" "}
          {estimate.property
            ? formatAddress(estimate.property)
            : "None selected"}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {isDraft ? (
            <SendEstimateButton
              estimateId={estimate.id}
              disabled={estimate.lineItems.length === 0 || needsCustomQuotePrices}
            />
          ) : null}
          {isSent ? <EditEstimateButton estimateId={estimate.id} /> : null}
          {isSent && hasCustomerEmail ? (
            <EmailEstimateButton estimateId={estimate.id} />
          ) : null}
          {isSent && !hasCustomerEmail ? (
            <p className="text-sm text-muted-foreground">
              No customer email on file. Add/copy the estimate link manually.
            </p>
          ) : null}
          {estimate.jobs[0] ? (
            <Button asChild size="sm" variant="outline">
              <Link href={`/jobs/${estimate.jobs[0].id}`}>Open job</Link>
            </Button>
          ) : isApproved ? (
            <CreateJobButton estimateId={estimate.id} />
          ) : null}
          <RecordNav
            customerId={estimate.customerId}
            backHref="/estimates"
            backLabel="Back to Estimates"
          />
        </div>
      </PageHeader>

      <Card>
        <CardHeader>
          <CardTitle>Line items</CardTitle>
          <CardDescription>
            {fromCustomerRequest && isDraft
              ? "Prefilled from customer request — review before sending."
              : "Server-calculated totals."}
          </CardDescription>
        </CardHeader>
        <CardContent>
          {estimate.lineItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No line items yet.</p>
          ) : (
            <ul className="space-y-3 text-sm">
              {estimate.lineItems.map((item) => {
                const priceRequired = isUnpricedCustomQuoteDraftLine(item);
                const requestName = customQuoteDisplayDescription(item.description);
                const calculatorSnapshot = lineCalculatorSnapshot(item.description);
                const calculatorId = resolveCalculatorId({
                  title: requestName,
                  snapshot: calculatorSnapshot,
                });
                const businessDefinition = calculatorId
                  ? findCatalogCalculatorDefinition(catalogItems, {
                      calculatorId,
                      catalogItemId: item.serviceCatalogItemId,
                      title: requestName,
                    })
                  : null;
                const calculatorComponents =
                  businessDefinition?.components ?? calculatorSnapshot?.components;
                const formRates = calculatorId
                  ? resolveCalculatorRatesForForm({
                      calculatorId,
                      snapshot: calculatorSnapshot,
                      businessRates: businessDefinition?.rates,
                      components: calculatorComponents,
                    })
                  : null;
                const formInputs = calculatorId
                  ? formCalculatorInputs({
                      calculatorId,
                      snapshot: calculatorSnapshot,
                      rates: formRates,
                      components: calculatorComponents,
                    })
                  : null;
                const customTemplate =
                  calculatorId === CUSTOM_VARIABLE_SCOPE_CALCULATOR_ID
                    ? templateForCalculator(calculatorId, calculatorComponents)
                    : null;
                const takeoffSource = lineMaterialTakeoffSource(item.description);
                const takeoffSnapshot = lineMaterialTakeoff(item.description);
                const takeoffType =
                  takeoffSnapshot?.takeoffType ??
                  suggestedTakeoffType({
                    calculatorId,
                    title: requestName,
                  }) ??
                  "concrete-slab";
                const takeoffSuggestion = suggestTakeoffInputs({
                  takeoffType,
                  calculatorSnapshot,
                  intakeMeasurement: pickIntakeMeasurementForLine(
                    storedIntakeMeasurements,
                    item.serviceCatalogItemId,
                  ),
                });
                return (
                  <li
                    key={item.id}
                    className={
                      priceRequired
                        ? "rounded-xl border-2 border-amber-500 bg-amber-50 p-3 dark:bg-amber-950/20"
                        : "space-y-1"
                    }
                  >
                    <div className="flex items-start justify-between gap-3">
                      <span className="min-w-0 flex-1 break-words">
                        {item.type === "LABOR"
                          ? "Labor"
                          : item.type === "MATERIAL"
                            ? "Material"
                            : "Other"}
                        : {lineItemTitle(item.description)} × {item.quantity.toString()}
                        {priceRequired
                          ? " — price required"
                          : ` @ ${formatMoney(item.unitPrice)}`}
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span>{formatMoney(item.total)}</span>
                        {isDraft ? (
                          <RemoveLineItemButton
                            estimateId={estimate.id}
                            lineItemId={item.id}
                          />
                        ) : null}
                      </span>
                    </div>
                    {isDraft && priceRequired && !calculatorId ? (
                      <>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Original customer request: {requestName}. Price this
                          same line — do not add a duplicate custom item.
                        </p>
                        <PriceRequiredLineForm
                          estimateId={estimate.id}
                          lineItemId={item.id}
                          quantity={item.quantity.toString()}
                        />
                      </>
                    ) : null}
                    {isDraft && calculatorId === DECORATIVE_WALL_PANELING_CALCULATOR_ID ? (
                      <VariableScopeCalculatorForm
                        estimateId={estimate.id}
                        lineItemId={item.id}
                        inputs={formInputs}
                        rates={formRates}
                        customerPolicy={lineCustomerPolicies(item.description)[0]}
                      />
                    ) : null}
                    {isDraft && customTemplate ? (
                      <VariableScopeDefinitionForm
                        estimateId={estimate.id}
                        lineItemId={item.id}
                        template={customTemplate}
                        inputs={formInputs}
                        rates={formRates}
                      />
                    ) : null}
                    {isDraft && !takeoffSource ? (
                      <MaterialTakeoffForm
                        estimateId={estimate.id}
                        lineItemId={item.id}
                        snapshot={takeoffSnapshot}
                        suggestedType={takeoffType}
                        suggestedInputs={takeoffSuggestion.inputs}
                        measurementSource={
                          takeoffSnapshot?.measurementSource ??
                          takeoffSuggestion.measurementSource
                        }
                        skippedMeasurements={
                          takeoffSnapshot?.skippedMeasurements.length
                            ? takeoffSnapshot.skippedMeasurements
                            : takeoffSuggestion.skippedMeasurements
                        }
                      />
                    ) : null}
                    {isDraft && calculatorId && item.unitPrice.gt(0) ? (
                      <OverrideLinePriceForm
                        estimateId={estimate.id}
                        lineItemId={item.id}
                        currentPrice={item.unitPrice.toString()}
                      />
                    ) : null}
                    {!isDraft && calculatorSnapshot?.result ? (
                      <CalculatorBreakdown snapshot={calculatorSnapshot} />
                    ) : null}
                    {isDraft ? (
                      <>
                        <EditLineIncludedWorkForm
                          estimateId={estimate.id}
                          lineItemId={item.id}
                          includedWork={lineItemIncludedWork(item.description)}
                        />
                        <SaveLineForReuseForm
                          estimateId={estimate.id}
                          lineItemId={item.id}
                          hasPrice={item.unitPrice.gt(0)}
                          currentPriceLabel={
                            item.unitPrice.gt(0) ? formatMoney(item.unitPrice) : null
                          }
                        />
                      </>
                    ) : (
                      <IncludedWorkDisplay description={item.description} />
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <EstimateCustomerPolicies
            className="mt-4 space-y-3"
            descriptions={estimate.lineItems.map((item) => item.description)}
          />
          <div className="mt-4 space-y-1 text-sm">
            <p>Labor subtotal: {formatMoney(laborSubtotal)}</p>
            {materialSubtotal.gt(0) ? (
              <p>Materials: {formatMoney(materialSubtotal)}</p>
            ) : null}
            {otherSubtotal.gt(0) ? (
              <p>Other: {formatMoney(otherSubtotal)}</p>
            ) : null}
            {isDraft &&
            business.laborMinimumEnabled &&
            business.laborMinimumAmount ? (
              <p>
                Minimum required: {formatMoney(business.laborMinimumAmount)}
              </p>
            ) : null}
            {estimate.laborMinimumWaived ? (
              <p>Labor minimum waived for this estimate.</p>
            ) : null}
            {estimate.laborMinimumAdjustment.gt(0) ? (
              <p>
                Labor Minimum Service Fee Adjustment —{" "}
                {formatMoney(estimate.laborMinimumAdjustment)}
              </p>
            ) : (
              <p>Minimum adjustment: {formatMoney(0)}</p>
            )}
            <p className="font-medium">
              Estimate total: {formatMoney(estimate.total)}
            </p>
          </div>
          {needsCustomQuotePrices ? (
            <p className="mt-3 text-sm font-medium text-amber-800 dark:text-amber-300">
              Price required on the highlighted original request line above.
              Send Estimate stays disabled until that price is saved. Do not
              add a second custom item for the same work.
            </p>
          ) : null}
          {isDraft ? (
            <div className="mt-4 flex flex-wrap items-center gap-3">
              <WaiveLaborMinimumButton
                estimateId={estimate.id}
                waived={estimate.laborMinimumWaived}
              />
              {estimate.lineItems.length > 0 ? (
                <ClearDraftEstimateButton estimateId={estimate.id} />
              ) : null}
            </div>
          ) : null}
        </CardContent>
      </Card>

      {isDraft ? (
        <>
      <Card>
        <CardHeader>
          <CardTitle>Add catalog item</CardTitle>
          <CardDescription>
            Uses the current catalog price and copies Scope / Included Work
            onto this estimate. Custom Quote services need a job price when
            added. The line is a snapshot and will not change if the catalog
            is edited later.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AddCatalogLineForm
            estimateId={estimate.id}
            items={catalogItems.map((item) => ({
              id: item.id,
              name: item.name,
              pricingMode: item.pricingMode,
              priceLabel: formatCatalogPriceLabel(item.pricingMode, item.price),
              includedWork: catalogScopeText(item.description),
              hasCalculator: Boolean(
                resolveCalculatorId({
                  title: item.name,
                  definition: catalogCalculatorDefinition(item.description),
                }),
              ),
              defaultPrice:
                item.price && item.price.gt(0) ? item.price.toString() : null,
            }))}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Add custom item</CardTitle>
          <CardDescription>
            Choose Labor, Material, or Other. Add Scope / Included Work if
            you want the customer to see what the price includes. Saving the
            service and scope to the catalog is optional and never automatic.
            The labor minimum uses labor lines only.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AddCustomLineForm estimateId={estimate.id} />
        </CardContent>
      </Card>
        </>
      ) : null}

      <EstimateVersionHistory versions={estimate.versions} />
    </PageContainer>
  );
}
