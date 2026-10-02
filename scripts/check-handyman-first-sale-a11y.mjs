/**
 * Focused accessibility contracts for the Handyman first-sale path:
 * public request, customer estimate approval, OWNER job scheduling,
 * and explicit invoice Send.
 *
 * Component renders use local fixtures only. No database, migrate,
 * customer message, or charge.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-handyman-first-sale-a11y.mjs
 */
import { readFileSync } from "node:fs";
import { register } from "node:module";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

register(new URL("./public-handyman-journey-test-loader.mjs", import.meta.url), import.meta.url);

const { HomeCatalogContinue } = await import(
  "@/components/public/home-catalog-continue"
);
const { PublicServicesBrowser } = await import(
  "@/components/public/public-services-browser"
);
const { RequestPhotoPicker } = await import(
  "@/components/public/request-photo-picker"
);
const { RequestPreferredWindowsFields } = await import(
  "@/components/public/request-preferred-windows-fields"
);
const { ServiceAddressFields } = await import(
  "@/components/public/service-address-fields"
);
const { MAX_INTAKE_PHOTOS } = await import("@/lib/service-request-work");

let passed = 0;
let failed = 0;
function check(label, ok) {
  if (ok) {
    passed += 1;
    console.log(`  ok  - ${label}`);
  } else {
    failed += 1;
    console.error(`FAIL - ${label}`);
  }
}

function readRepo(rel) {
  return readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

function attr(html, name) {
  const match = html.match(new RegExp(`\\s${name}="([^"]*)"`, "i"));
  return match ? match[1] : null;
}

function hasId(html, id) {
  return html.includes(`id="${id}"`);
}

function describedByTargetsExist(html, describedBy) {
  if (!describedBy) return false;
  return describedBy.split(/\s+/).every((id) => hasId(html, id));
}

function catalogItem(id, name, category = "Repairs") {
  return {
    id,
    name,
    description: `${name} description`,
    category,
    pricingMode: "FIXED",
    priceLabel: "$95",
    unitAmount: 95,
    intakeMeasurementMode: "OFF",
    intakeMeasurementAxes: "",
    intakeMeasurementUnit: "IN",
    asksWorkAreaIntake: false,
    tradeCode: "HANDYMAN",
  };
}

const catalogItemA = catalogItem("svc-fence", "Fence repair");
const groups = [{ category: "Repairs", items: [catalogItemA] }];
const emptySelected = {
  catalogIds: [],
  quantities: {},
  includeOther: false,
  otherDescription: "",
  otherQuantity: 1,
};
const serviceArea = {
  country: "US",
  region: "FL",
  cities: ["Naples", "Fort Myers"],
};

const requestFlowSrc = readRepo("src/components/public/request-flow.tsx");
const servicesBrowserSrc = readRepo("src/components/public/public-services-browser.tsx");
const homeContinueSrc = readRepo("src/components/public/home-catalog-continue.tsx");
const photoPickerSrc = readRepo("src/components/public/request-photo-picker.tsx");
const preferredFieldsSrc = readRepo(
  "src/components/public/request-preferred-windows-fields.tsx",
);
const servicePickerSrc = readRepo("src/components/public/service-picker.tsx");
const approveSrc = readRepo("src/components/estimates/approve-estimate-button.tsx");
const scheduleSrc = readRepo("src/components/jobs/schedule-job-form.tsx");
const sendSrc = readRepo("src/components/invoices/mark-invoice-sent-button.tsx");
const headerSrc = readRepo("src/components/public/public-header.tsx");
const jobsWorkspaceSrc = readRepo("src/components/jobs/jobs-workspace.tsx");
const invoicesWorkspaceSrc = readRepo("src/components/invoices/invoices-workspace.tsx");
const sheetSrc = readRepo("src/components/ui/sheet.tsx");
const publicCssSrc = readRepo("src/components/public/public-site.css");
const packageSrc = readRepo("package.json");

console.log("\nSTATIC — Public request labels, focus, errors, disabled continue");
check(
  "Request wizard focuses the error alert when validation fails",
  requestFlowSrc.includes("errorRef.current?.focus()") &&
    requestFlowSrc.includes("<Alert ref={errorRef} tabIndex={-1} variant=\"destructive\">"),
);
check(
  "Request wizard moves keyboard focus to the new step heading",
  requestFlowSrc.includes("stepHeadingRef.current?.focus()") &&
    requestFlowSrc.includes("skipStepFocusRef") &&
    requestFlowSrc.includes("tabIndex={-1}") &&
    requestFlowSrc.includes("ref={stepHeadingRef}"),
);
check(
  "Custom-trade select is labelled by the fieldset legend and an id",
  requestFlowSrc.includes('id="requestedTradeCode"') &&
    requestFlowSrc.includes("Which type of work is this?"),
);
check(
  "Home continue stays focusable and explains why it is not available",
  homeContinueSrc.includes('aria-disabled="true"') &&
    homeContinueSrc.includes('aria-describedby="home-select-work-help"') &&
    homeContinueSrc.includes("Choose at least one service or other work") &&
    !/public-btn-outline[^>]*\sdisabled/.test(homeContinueSrc),
);
check(
  "Services browser continue is aria-disabled with the existing help text",
  servicesBrowserSrc.includes('aria-disabled="true"') &&
    servicesBrowserSrc.includes('aria-describedby="selected-work-continue-help"') &&
    servicesBrowserSrc.includes('id="selected-work-continue-help"') &&
    servicesBrowserSrc.includes("Select one or more tasks to continue."),
);
check(
  "Cross-trade and photo errors are announced",
  servicesBrowserSrc.includes('role="alert"') &&
    servicePickerSrc.includes('role="alert"') &&
    photoPickerSrc.includes('role="alert"'),
);
check(
  "Other-work textarea and photo controls have names",
  servicesBrowserSrc.includes('htmlFor="other-work-description"') &&
    servicesBrowserSrc.includes("Describe the other work") &&
    photoPickerSrc.includes('id="photos-help"') &&
    photoPickerSrc.includes("Remove a photo to add another") &&
    photoPickerSrc.includes("{photo.file.name}"),
);
check(
  "Service category chips are pressed buttons, not an incomplete tablist",
  servicesBrowserSrc.includes("aria-pressed={item.category === group.category}") &&
    servicePickerSrc.includes('role="group"') &&
    servicePickerSrc.includes("aria-pressed={selected}") &&
    !servicePickerSrc.includes('role="tablist"'),
);
check(
  "Preferred-window remove buttons name the row",
  preferredFieldsSrc.includes("preference {index + 1}"),
);
check(
  "Public mobile menu can be closed from the keyboard",
  headerSrc.includes('event.key === "Escape"') &&
    headerSrc.includes("setOpen(false)") &&
    headerSrc.includes('aria-controls="public-mobile-nav"'),
);
check(
  "Aria-disabled public buttons keep the disabled look",
  publicCssSrc.includes('.public-btn[aria-disabled="true"]'),
);

console.log("\nSTATIC — Estimate approval, job scheduling, invoice Send");
check(
  "Customer approve focuses and describes the error",
  approveSrc.includes("errorRef.current?.focus()") &&
    approveSrc.includes("tabIndex={-1}") &&
    approveSrc.includes("aria-describedby={state.error ? errorId : undefined}") &&
    approveSrc.includes("aria-busy={pending || undefined}"),
);
check(
  "Approve still records acceptance before any deposit checkout",
  approveSrc.includes("Approve Estimate") &&
    approveSrc.includes("form.action = `/e/${publicToken}/pay`") &&
    approveSrc.includes("needsDeposit && paymentReady"),
);
check(
  "Schedule form focuses status alerts and describes the unpaid-deposit warning",
  scheduleSrc.includes("statusRef.current?.focus()") &&
    scheduleSrc.includes('id={`deposit-warning-${jobId}`}') &&
    scheduleSrc.includes("aria-describedby={unpaidDepositWarning ? `deposit-warning-${jobId}` : undefined}") &&
    scheduleSrc.includes("window.confirm") &&
    scheduleSrc.includes("Schedule the job anyway?"),
);
check(
  "Explicit invoice Send surfaces, announces, and focuses errors",
  sendSrc.includes("markInvoiceSent(") &&
    sendSrc.includes("errorRef.current?.focus()") &&
    sendSrc.includes("tabIndex={-1}") &&
    sendSrc.includes("aria-describedby={state.error ? errorId : undefined}") &&
    sendSrc.includes("Send Invoice"),
);
check(
  "Job and invoice mobile sheets stay titled dialogs with a labelled close",
  jobsWorkspaceSrc.includes("<SheetTitle>Job details</SheetTitle>") &&
    invoicesWorkspaceSrc.includes("<SheetTitle>Invoice details</SheetTitle>") &&
    sheetSrc.includes("<SheetOverlay />") &&
    sheetSrc.includes("<span className=\"sr-only\">Close</span>"),
);

console.log("\nCOMPONENT — rendered first-sale controls");
const homeHtml = renderToStaticMarkup(
  createElement(HomeCatalogContinue, {
    slug: "demo-handyman",
    items: [catalogItemA],
    groups,
  }),
);
check(
  "Home continue button is in the tab order and points at its explanation",
  /<button type="button"[^>]*aria-disabled="true"[^>]*aria-describedby="home-select-work-help"/.test(
    homeHtml,
  ) &&
    !/<button[^>]*\sdisabled[=>\s]/.test(homeHtml) &&
    describedByTargetsExist(homeHtml, "home-select-work-help") &&
    homeHtml.includes("Choose at least one service or other work"),
);
check(
  "Home category filters stay keyboard buttons with pressed state",
  homeHtml.includes('aria-pressed="true"') &&
    homeHtml.includes('aria-label="Service categories"') &&
    !homeHtml.includes('role="tablist"'),
);

const browserHtml = renderToStaticMarkup(
  createElement(PublicServicesBrowser, {
    slug: "demo-handyman",
    items: [catalogItemA],
    groups,
    initialSelected: emptySelected,
    categoryImages: {},
  }),
);
check(
  "Empty services selection keeps a focusable continue control with help",
  browserHtml.includes("Continue with Selected Work") &&
    browserHtml.includes('aria-disabled="true"') &&
    describedByTargetsExist(browserHtml, attr(browserHtml, "aria-describedby")) &&
    browserHtml.includes("Select one or more tasks to continue."),
);
check(
  "Service details control names the service",
  browserHtml.includes("Details for Fence repair") &&
    browserHtml.includes("Select Fence repair"),
);

const otherHtml = renderToStaticMarkup(
  createElement(PublicServicesBrowser, {
    slug: "demo-handyman",
    items: [catalogItemA],
    groups,
    initialSelected: { ...emptySelected, includeOther: true },
    categoryImages: {},
  }),
);
check(
  "Other-work description is a labelled text field",
  otherHtml.includes('for="other-work-description"') &&
    otherHtml.includes('id="other-work-description"') &&
    otherHtml.includes("Describe the other work"),
);

const addressHtml = renderToStaticMarkup(
  createElement(ServiceAddressFields, {
    value: {
      streetAddress: "",
      unit: "",
      city: "",
      region: "FL",
      postalCode: "",
    },
    onChange() {},
    serviceArea,
  }),
);
check(
  "Service address fields expose legend and labelled inputs",
  addressHtml.includes("Service address") &&
    addressHtml.includes('for="streetAddress"') &&
    addressHtml.includes('id="streetAddress"') &&
    addressHtml.includes('for="citySelect"') &&
    addressHtml.includes('id="postalCode"'),
);

const preferredHtml = renderToStaticMarkup(
  createElement(RequestPreferredWindowsFields, {
    value: [{ kind: "DAY", localDate: "2026-10-03", startLocal: "", endLocal: "" }],
    onChange() {},
  }),
);
check(
  "Preferred-window row can be removed by an identifiable button",
  preferredHtml.includes("Remove") &&
    preferredHtml.includes("preference 1") &&
    preferredHtml.includes('for="preferred-date-0"') &&
    preferredHtml.includes('id="preferred-date-0"'),
);

const photos = Array.from({ length: MAX_INTAKE_PHOTOS }, (_, index) => ({
  id: `photo-${index}`,
  file: new File(["fixture"], `deck-${index + 1}.jpg`, { type: "image/jpeg" }),
  previewUrl: "",
  mimeType: "image/jpeg",
  previewable: false,
}));
const photoHtml = renderToStaticMarkup(
  createElement(RequestPhotoPicker, {
    photos,
    onChange() {},
    businessName: "Demo Handyman",
  }),
);
check(
  "Full photo picker stays reachable and explains the limit",
  photoHtml.includes('id="photos"') &&
    photoHtml.includes('id="photos-full"') &&
    describedByTargetsExist(photoHtml, attr(photoHtml.match(/id="photos"[^>]*>/)?.[0] ?? photoHtml, "aria-describedby") ?? "photos-help photos-full") &&
    photoHtml.includes("Photo limit reached") &&
    photoHtml.includes("Remove") &&
    photoHtml.includes("deck-1.jpg") &&
    !/id="photos"[^>]*disabled/.test(photoHtml),
);

console.log("\nBROWSER-SHAPE — first-sale markup stays keyboard-complete");
const continueMatch = browserHtml.match(
  /<button[^>]*aria-disabled="true"[^>]*>[\s\S]*?Continue with Selected Work/,
);
check(
  "Disabled continue is a button, not a dead non-focusable control",
  Boolean(continueMatch) && !/\sdisabled[=>\s]/.test(continueMatch[0]),
);
check(
  "Job sheet close remains a named control in the shared dialog",
  sheetSrc.includes("SheetPrimitive.Close") &&
    sheetSrc.includes("Close") &&
    jobsWorkspaceSrc.includes("onOpenChange={setMobileOpen}"),
);
check(
  "package.json registers the first-sale a11y check",
  packageSrc.includes("test:handyman-first-sale-a11y") &&
    packageSrc.includes("check-handyman-first-sale-a11y.mjs"),
);

console.log(
  failed === 0
    ? `\nAll Handyman first-sale a11y checks passed (${passed}).`
    : `\n${failed} Handyman first-sale a11y check(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
