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
import {
  ResetTakeoffAndGeneratedMaterialsForm,
  RestoreOriginalRequestPricingForm,
} from "@/components/estimates/draft-estimate-recovery-forms";
import { EstimateCustomerPolicies } from "@/components/estimates/customer-policy-display";
import { EstimateTermsEditor } from "@/components/estimates/estimate-terms-editor";
import { IncludedWorkDisplay } from "@/components/estimates/included-work-display";
import { OverrideLinePriceForm } from "@/components/estimates/override-line-price-form";
import { PriceRequiredLineForm } from "@/components/estimates/price-required-line-form";
import { VariableScopeCalculatorForm } from "@/components/estimates/variable-scope-calculator-form";
import { VariableScopeDefinitionForm } from "@/components/estimates/variable-scope-definition-form";
import {
  EstimatingTakeoffProvider,
  LaborTakeoffPanel,
  MaterialTakeoffForm,
  MaterialTakeoffPanel,
} from "@/components/estimates/material-takeoff-form";
import { MaterialDepositForm } from "@/components/estimates/material-deposit-form";
import {
  OwnerRecordDepositSection,
  ProjectPaymentSummaryCard,
} from "@/components/payments/project-payment-summary";
import { CustomerMaterialsTotalForm } from "@/components/estimates/customer-materials-total-form";
import { EditMaterialLineForm } from "@/components/estimates/edit-material-line-form";
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
  descriptionLooksLikeCustomQuote,
  findCatalogCalculatorDefinition,
  formCalculatorInputs,
  resolveCalculatorId,
  resolveCalculatorRatesForForm,
  resolveEstimatingWorkspace,
  templateForCalculator,
} from "@/lib/estimate-calculators";
import {
  catalogCalculatorDefinition,
  catalogScopeText,
  canSaveEstimateLineToServiceCatalog,
  isOriginalEstimateWorkLine,
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
import { resolveMaterialDeposit } from "@/lib/material-deposit";
import {
  loadEstimatePaymentSummary,
  unpaidMaterialDepositWarning,
} from "@/lib/project-payments";
import {
  collectEstimateTermContext,
  composeEstimateTerms,
  partitionEstimateTerms,
} from "@/lib/estimate-terms/compose";
import { resolveCustomerMaterialsTotal } from "@/lib/customer-materials-total";
import { loadBusinessEstimatingDefaults } from "@/lib/estimating-defaults-db";
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
      approvedVersion: {
        select: {
          total: true,
          lineItems: { orderBy: { createdAt: "asc" } },
        },
      },
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
  const laborLines = estimate.lineItems.filter((item) => item.type === "LABOR");
  const materialLines = estimate.lineItems.filter((item) => item.type === "MATERIAL");
  const otherLines = estimate.lineItems.filter((item) => item.type === "OTHER");
  const customerMaterials = resolveCustomerMaterialsTotal(estimate.lineItems);
  const otherSubtotal = estimate.lineItems
    .filter((item) => item.type === "OTHER")
    .reduce((sum, item) => sum.add(item.total), new Prisma.Decimal(0));
  const depositLines = estimate.approvedVersion?.lineItems ?? estimate.lineItems;
  const depositTotal = estimate.approvedVersion?.total ?? estimate.total;
  const materialDeposit = resolveMaterialDeposit({
    lines: depositLines,
    total: depositTotal,
  });
  const paymentSummary = await loadEstimatePaymentSummary(prisma, {
    businessId: access.businessId,
    estimateId: estimate.id,
    estimateTotal: depositTotal,
    requiredDeposit: materialDeposit.amount,
    jobId: estimate.jobs[0]?.id ?? null,
  });
  const unpaidDepositWarning = unpaidMaterialDepositWarning(
    paymentSummary.depositRemaining,
  );
  const business = access.workspace.business;
  const isDraft = estimate.status === "DRAFT";
  const isSent = estimate.status === "SENT";
  const isApproved = estimate.status === "APPROVED";
  const termContext = collectEstimateTermContext(estimate.lineItems);
  const composedTerms = isDraft
    ? composeEstimateTerms({
        existing: termContext.existing,
        titles: termContext.titles,
        takeoffType: termContext.takeoffType,
        calculatorId: termContext.calculatorId,
        intake: parseWorkAreaIntake(estimate.serviceRequest?.description),
        hasMaterials: materialLines.length > 0,
        hasDeposit: materialDeposit.amount.gt(0),
      })
    : termContext.existing;
  const customerTerms = partitionEstimateTerms(composedTerms);
  const customerEmail = estimate.customer?.email ?? "";
  const hasCustomerEmail = isUsableEmail(customerEmail);
  const needsCustomQuotePrices = estimate.lineItems.some(isUnpricedCustomQuoteDraftLine);
  const fromCustomerRequest = Boolean(estimate.serviceRequestId);
  const hasOriginalWorkLine = estimate.lineItems.some(isOriginalEstimateWorkLine);
  const originalWorkLine = estimate.lineItems.find(isOriginalEstimateWorkLine) ?? null;
  const requestWorkspaceTitles = [
    estimate.serviceRequest?.summary,
    estimate.serviceRequest?.serviceCatalogItem?.name,
    ...(estimate.serviceRequest?.items ?? []).flatMap((item) => [
      item.customDescription,
      item.serviceCatalogItem?.name,
    ]),
    originalWorkLine
      ? customQuoteDisplayDescription(originalWorkLine.description)
      : null,
  ];
  const draftWorkspace = isDraft
    ? resolveEstimatingWorkspace({
        title:
          (originalWorkLine
            ? customQuoteDisplayDescription(originalWorkLine.description)
            : null) ??
          estimate.serviceRequest?.summary ??
          estimate.serviceRequest?.serviceCatalogItem?.name,
        titles: requestWorkspaceTitles,
        calculatorId: originalWorkLine
          ? resolveCalculatorId({
              title: customQuoteDisplayDescription(originalWorkLine.description),
              snapshot: lineCalculatorSnapshot(originalWorkLine.description),
            })
          : resolveCalculatorId({
              title: estimate.serviceRequest?.summary,
            }),
        takeoffType: originalWorkLine
          ? lineMaterialTakeoff(originalWorkLine.description)?.takeoffType
          : null,
        customQuote:
          fromCustomerRequest ||
          estimate.lineItems.some(
            (item) =>
              isUnpricedCustomQuoteDraftLine(item) ||
              descriptionLooksLikeCustomQuote(item.description),
          ),
        alwaysProvideWorkspace:
          fromCustomerRequest ||
          estimate.lineItems.some(isUnpricedCustomQuoteDraftLine),
      })
    : null;
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

  const originalTakeoffWorkspace = (() => {
    if (!isDraft || !originalWorkLine) return null;
    const requestName = customQuoteDisplayDescription(originalWorkLine.description);
    const calculatorSnapshot = lineCalculatorSnapshot(originalWorkLine.description);
    const calculatorId = resolveCalculatorId({
      title: requestName,
      snapshot: calculatorSnapshot,
    });
    const takeoffSnapshot = lineMaterialTakeoff(originalWorkLine.description);
    const lineWorkspace = resolveEstimatingWorkspace({
      title: requestName,
      titles: [requestName, ...requestWorkspaceTitles],
      calculatorId,
      takeoffType: takeoffSnapshot?.takeoffType,
      customQuote:
        isUnpricedCustomQuoteDraftLine(originalWorkLine) ||
        descriptionLooksLikeCustomQuote(originalWorkLine.description),
      alwaysProvideWorkspace: Boolean(draftWorkspace),
    });
    const takeoffType =
      takeoffSnapshot?.takeoffType ??
      lineWorkspace?.material.takeoffType ??
      draftWorkspace?.material.takeoffType ??
      suggestedTakeoffType({
        calculatorId,
        title: requestName,
        titles: requestWorkspaceTitles,
      }) ??
      "generic-custom";
    const takeoffSuggestion = suggestTakeoffInputs({
      takeoffType,
      calculatorSnapshot,
      intakeMeasurement: pickIntakeMeasurementForLine(
        storedIntakeMeasurements,
        originalWorkLine.serviceCatalogItemId,
      ),
    });
    if (
      takeoffSnapshot == null &&
      lineWorkspace == null &&
      draftWorkspace == null
    ) {
      return null;
    }
    return {
      lineItemId: originalWorkLine.id,
      snapshot: takeoffSnapshot,
      suggestedType: takeoffType,
      suggestedInputs: takeoffSuggestion.inputs,
      measurementSource:
        takeoffSnapshot?.measurementSource ?? takeoffSuggestion.measurementSource,
      skippedMeasurements: takeoffSnapshot?.skippedMeasurements.length
        ? takeoffSnapshot.skippedMeasurements
        : takeoffSuggestion.skippedMeasurements,
      workspaceTitle: lineWorkspace?.title ?? draftWorkspace?.title ?? null,
      workspaceId: lineWorkspace?.id ?? draftWorkspace?.id ?? null,
    };
  })();

  const businessEstimatingWorkspaceId =
    originalTakeoffWorkspace?.workspaceId ?? draftWorkspace?.id ?? null;
  const businessDefaults =
    isDraft && businessEstimatingWorkspaceId
      ? await loadBusinessEstimatingDefaults(
          prisma,
          access.businessId,
          businessEstimatingWorkspaceId,
        )
      : null;

  const laborSection = (
    <Card>
      <CardHeader>
        <CardTitle>LABOR — Calculate & Price the Work</CardTitle>
        <CardDescription>
          Calculate the labor required for this job, review the recommended
          price, make any adjustments, and define what work is included.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {isDraft && fromCustomerRequest && !hasOriginalWorkLine ? (
          <div className="space-y-2 rounded-lg border border-amber-500/60 bg-amber-50 p-3 dark:bg-amber-950/20">
            <p className="text-sm font-medium">
              The original customer-request labor/work line is missing.
              Concrete/custom calculators are still available — they are not
              stored on that disposable line.
            </p>
            <p className="text-xs text-muted-foreground">
              Restore reconstructs the original unpriced labor/work line from
              the linked request so takeoff results have a place to save. This
              does not create a duplicate, does not change photos or intake,
              and does not recreate takeoff-generated material lines.
            </p>
            <RestoreOriginalRequestPricingForm
              estimateId={estimate.id}
              missingOriginalLine
            />
            {draftWorkspace ? (
              <MaterialTakeoffForm
                estimateId={estimate.id}
                snapshot={null}
                suggestedType={draftWorkspace.material.takeoffType}
                suggestedInputs={suggestTakeoffInputs({
                  takeoffType: draftWorkspace.material.takeoffType,
                  calculatorSnapshot: null,
                  intakeMeasurement: pickIntakeMeasurementForLine(
                    storedIntakeMeasurements,
                    estimate.serviceRequest?.items[0]?.serviceCatalogItem?.id ??
                      null,
                  ),
                }).inputs}
                measurementSource={
                  suggestTakeoffInputs({
                    takeoffType: draftWorkspace.material.takeoffType,
                    intakeMeasurement: pickIntakeMeasurementForLine(
                      storedIntakeMeasurements,
                      estimate.serviceRequest?.items[0]?.serviceCatalogItem?.id ??
                        null,
                    ),
                  }).measurementSource
                }
                workspaceTitle={draftWorkspace.title}
                workspaceId={draftWorkspace.id}
                businessDefaults={businessDefaults}
              />
            ) : null}
          </div>
        ) : null}
        {originalTakeoffWorkspace ? <LaborTakeoffPanel /> : null}
        {laborLines.length === 0 && !originalTakeoffWorkspace ? (
          <p className="text-sm text-muted-foreground">No labor lines yet.</p>
        ) : (
          <ul className="space-y-4 text-sm">
            {laborLines.map((item) => (
              <OwnerEstimateLaborLine
                key={item.id}
                item={item}
                estimateId={estimate.id}
                isDraft={isDraft}
                catalogItems={catalogItems}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );

  const materialsSection = (
    <Card>
      <CardHeader>
        <CardTitle>MATERIALS — Calculate & Price the Materials</CardTitle>
        <CardDescription>
          Calculate what the job requires, review your costs and markup, and
          choose the final materials amount charged to the customer.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {originalTakeoffWorkspace ? <MaterialTakeoffPanel /> : null}
        <div>
          <h3 className="text-sm font-semibold">Customer Materials</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            This is the material list that will appear on the estimate and
            invoice when you supply the materials. Customers see the material
            description and quantity, but not your individual material prices.
          </p>
          {materialLines.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">
              No converted material lines yet.
            </p>
          ) : (
            <table className="mt-3 w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs tracking-wider text-muted-foreground">
                  <th className="py-1.5 pr-3 font-semibold">Description</th>
                  <th className="py-1.5 px-3 text-right font-semibold">Qty</th>
                  {isDraft ? (
                    <>
                      <th className="py-1.5 pl-2 text-right font-semibold">
                        Edit
                      </th>
                      <th className="py-1.5 pl-2 text-right font-semibold">
                        Remove
                      </th>
                    </>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {materialLines.map((item) => (
                  <tr key={item.id} className="border-t border-border/60">
                    <td className="py-1.5 pr-3 align-top">
                      {lineItemTitle(item.description)}
                    </td>
                    <td className="py-1.5 px-3 text-right align-top tabular-nums">
                      {item.quantity.toString()}
                    </td>
                    {isDraft ? (
                      <>
                        <td className="py-1.5 pl-2 text-right align-top">
                          <EditMaterialLineForm
                            estimateId={estimate.id}
                            lineItemId={item.id}
                            title={lineItemTitle(item.description)}
                            quantity={item.quantity.toString()}
                          />
                        </td>
                        <td className="py-1.5 pl-2 text-right align-top">
                          <RemoveLineItemButton
                            estimateId={estimate.id}
                            lineItemId={item.id}
                          />
                        </td>
                      </>
                    ) : null}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        {customerMaterials.calculated.gt(0) || customerMaterials.manual ? (
          <div className="space-y-1 text-sm">
            <p>
              Calculated Materials Total:{" "}
              {formatMoney(customerMaterials.calculated)}
            </p>
            <p>
              Final Customer Materials Total:{" "}
              {formatMoney(customerMaterials.amount)}
            </p>
            {customerMaterials.differs ? (
              <p className="text-amber-800 dark:text-amber-300">
                Final Customer Materials Total differs from the calculated
                total. Recalculation will not overwrite it.
              </p>
            ) : null}
          </div>
        ) : null}
        {isDraft && (materialLines.length > 0 || customerMaterials.manual) ? (
          <CustomerMaterialsTotalForm
            estimateId={estimate.id}
            calculatedLabel={formatMoney(customerMaterials.calculated)}
            currentAmount={customerMaterials.amount.toFixed(2)}
            manual={customerMaterials.manual}
            differs={customerMaterials.differs}
          />
        ) : null}
        {isDraft && originalTakeoffWorkspace ? (
          <div className="border-t border-dashed border-border pt-4">
            <p className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Advanced / recovery
            </p>
            <ResetTakeoffAndGeneratedMaterialsForm
              estimateId={estimate.id}
              lineItemId={originalTakeoffWorkspace.lineItemId}
            />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );

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
            <CreateJobButton
              estimateId={estimate.id}
              unpaidDepositWarning={unpaidDepositWarning}
            />
          ) : null}
          <RecordNav
            customerId={estimate.customerId}
            backHref="/estimates"
            backLabel="Back to Estimates"
          />
        </div>
      </PageHeader>

      {originalTakeoffWorkspace ? (
        <EstimatingTakeoffProvider
          key={originalTakeoffWorkspace.lineItemId}
          estimateId={estimate.id}
          lineItemId={originalTakeoffWorkspace.lineItemId}
          snapshot={originalTakeoffWorkspace.snapshot}
          suggestedType={originalTakeoffWorkspace.suggestedType}
          suggestedInputs={originalTakeoffWorkspace.suggestedInputs}
          measurementSource={originalTakeoffWorkspace.measurementSource}
          skippedMeasurements={originalTakeoffWorkspace.skippedMeasurements}
          workspaceTitle={originalTakeoffWorkspace.workspaceTitle}
          workspaceId={originalTakeoffWorkspace.workspaceId}
          businessDefaults={businessDefaults}
        >
          {laborSection}
          {materialsSection}
        </EstimatingTakeoffProvider>
      ) : (
        <>
          {laborSection}
          {materialsSection}
        </>
      )}

      <Card>
        <CardHeader>
          <CardTitle>ESTIMATE SUMMARY — Review Before Sending</CardTitle>
          <CardDescription>
            Review the customer price and material deposit before sending the
            estimate.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="space-y-1 text-sm">
            <div className="flex justify-between gap-3">
              <dt>Labor</dt>
              <dd className="tabular-nums">{formatMoney(laborSubtotal)}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>Materials</dt>
              <dd className="tabular-nums">
                {formatMoney(customerMaterials.amount)}
              </dd>
            </div>
            {otherSubtotal.gt(0) ? (
              <div className="flex justify-between gap-3">
                <dt>Other</dt>
                <dd className="tabular-nums">{formatMoney(otherSubtotal)}</dd>
              </div>
            ) : null}
            <div className="flex justify-between gap-3 font-medium">
              <dt>Estimate Total</dt>
              <dd className="tabular-nums">{formatMoney(estimate.total)}</dd>
            </div>
            <div className="mt-3 flex justify-between gap-3">
              <dt>Material Deposit Due</dt>
              <dd className="tabular-nums">
                {formatMoney(materialDeposit.amount)}
              </dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt>Remaining Balance</dt>
              <dd className="tabular-nums">
                {formatMoney(materialDeposit.remaining)}
              </dd>
            </div>
          </dl>
          {!isDraft ? (
            <div className="mt-4 space-y-4 border-t border-border pt-4">
              <ProjectPaymentSummaryCard
                summary={paymentSummary}
                warning={unpaidDepositWarning}
              />
              <OwnerRecordDepositSection
                estimateId={estimate.id}
                summary={paymentSummary}
              />
            </div>
          ) : null}
          {isDraft &&
          business.laborMinimumEnabled &&
          business.laborMinimumAmount ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Minimum required: {formatMoney(business.laborMinimumAmount)}
            </p>
          ) : null}
          {estimate.laborMinimumWaived ? (
            <p className="mt-2 text-sm text-muted-foreground">
              Labor minimum waived for this estimate.
            </p>
          ) : null}
          {estimate.laborMinimumAdjustment.gt(0) ? (
            <p className="mt-2 text-sm">
              Labor Minimum Service Fee Adjustment —{" "}
              {formatMoney(estimate.laborMinimumAdjustment)}
            </p>
          ) : null}
          {otherLines.length > 0 ? (
            <ul className="mt-4 space-y-2 text-sm">
              {otherLines.map((item) => (
                <li key={item.id} className="flex items-start justify-between gap-3">
                  <span className="min-w-0 flex-1 break-words">
                    Other: {lineItemTitle(item.description)} × {item.quantity.toString()}{" "}
                    @ {formatMoney(item.unitPrice)}
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
                </li>
              ))}
            </ul>
          ) : null}
          {isDraft ? (
            <MaterialDepositForm
              estimateId={estimate.id}
              suggestedLabel={formatMoney(materialDeposit.suggested)}
              currentAmount={materialDeposit.amount.toFixed(2)}
              remainingLabel={formatMoney(materialDeposit.remaining)}
              manual={materialDeposit.manual}
              suggestedChanged={materialDeposit.suggestedChanged}
            />
          ) : null}
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

      {estimate.lineItems.length > 0 && composedTerms.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>Project conditions & terms</CardTitle>
            <CardDescription>
              {isDraft
                ? "Review customer-facing conditions and terms before sending. Optional terms can be turned off for this estimate."
                : "Customer-facing conditions and terms sent with this estimate."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isDraft ? (
              <EstimateTermsEditor
                estimateId={estimate.id}
                policies={composedTerms}
              />
            ) : (
              <EstimateCustomerPolicies
                projectConditions={customerTerms.projectConditions}
                terms={customerTerms.terms}
              />
            )}
          </CardContent>
        </Card>
      ) : null}

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
            Choose Labor, Material, or Other. Add Scope / Included Work on
            labor/service lines if you want the customer to see what the price
            includes. Material lines stay compact — the customer sees quantity
            and one Materials Total. Saving the service and scope to the catalog
            is optional and never automatic. The labor minimum uses labor lines
            only.
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

function OwnerEstimateLaborLine({
  item,
  estimateId,
  isDraft,
  catalogItems,
}: {
  item: {
    id: string;
    type: string;
    description: string;
    quantity: { toString(): string };
    unitPrice: Prisma.Decimal;
    total: Prisma.Decimal;
    serviceCatalogItemId: string | null;
  };
  estimateId: string;
  isDraft: boolean;
  catalogItems: Awaited<ReturnType<typeof prisma.serviceCatalogItem.findMany>>;
}) {
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

  return (
    <li
      className={
        priceRequired
          ? "rounded-xl border-2 border-amber-500 bg-amber-50 p-3 dark:bg-amber-950/20"
          : "space-y-1"
      }
    >
      <div className="flex items-start justify-between gap-3">
        <span className="min-w-0 flex-1 break-words">
          Labor: {lineItemTitle(item.description)} × {item.quantity.toString()}
          {priceRequired ? " — price required" : ` @ ${formatMoney(item.unitPrice)}`}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span>{formatMoney(item.total)}</span>
          {isDraft ? (
            <RemoveLineItemButton estimateId={estimateId} lineItemId={item.id} />
          ) : null}
        </span>
      </div>
      {isDraft && !priceRequired ? (
        <p className="text-sm">
          Current / applied labor price: {formatMoney(item.unitPrice)}
        </p>
      ) : null}
      {isDraft && priceRequired && !calculatorId ? (
        <>
          <p className="mt-1 text-xs text-muted-foreground">
            Original customer request: {requestName}. Price this same line — do
            not add a duplicate custom item.
          </p>
          <PriceRequiredLineForm
            estimateId={estimateId}
            lineItemId={item.id}
            quantity={item.quantity.toString()}
          />
        </>
      ) : null}
      {isDraft && calculatorId === DECORATIVE_WALL_PANELING_CALCULATOR_ID ? (
        <VariableScopeCalculatorForm
          estimateId={estimateId}
          lineItemId={item.id}
          inputs={formInputs}
          rates={formRates}
          customerPolicy={lineCustomerPolicies(item.description)[0]}
        />
      ) : null}
      {isDraft && customTemplate ? (
        <VariableScopeDefinitionForm
          estimateId={estimateId}
          lineItemId={item.id}
          template={customTemplate}
          inputs={formInputs}
          rates={formRates}
        />
      ) : null}
      {isDraft && item.unitPrice.gt(0) && (calculatorId || takeoffSnapshot) ? (
        <OverrideLinePriceForm
          estimateId={estimateId}
          lineItemId={item.id}
          currentPrice={item.unitPrice.toString()}
          label="Owner labor price override"
        />
      ) : null}
      {!isDraft && calculatorSnapshot?.result ? (
        <CalculatorBreakdown snapshot={calculatorSnapshot} />
      ) : null}
      {isDraft ? (
        <>
          <EditLineIncludedWorkForm
            estimateId={estimateId}
            lineItemId={item.id}
            includedWork={lineItemIncludedWork(item.description)}
          />
          {!takeoffSource ? (
            <RestoreOriginalRequestPricingForm
              estimateId={estimateId}
              lineItemId={item.id}
            />
          ) : null}
          {canSaveEstimateLineToServiceCatalog(item) ? (
            <SaveLineForReuseForm
              estimateId={estimateId}
              lineItemId={item.id}
              hasPrice={item.unitPrice.gt(0)}
              currentPriceLabel={
                item.unitPrice.gt(0) ? formatMoney(item.unitPrice) : null
              }
            />
          ) : null}
        </>
      ) : (
        <IncludedWorkDisplay description={item.description} />
      )}
    </li>
  );
}
