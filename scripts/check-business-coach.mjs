/**
 * Owner-facing Business Coach routing and synthesis proofs.
 *
 * Run with:
 *   node --experimental-strip-types scripts/check-business-coach.mjs
 */
import { register } from "node:module";
import { readFileSync } from "node:fs";

register(new URL("./ts-alias-loader.mjs", import.meta.url), import.meta.url);

const { answerCoachFromFacts, coachSystemPrompt } = await import("@/lib/ai/coach");
const { EMPTY_BSOS_FACTS } = await import("@/lib/bsos");
const { CAPABILITIES, roleHasCapability } = await import("@/lib/authorization");
const { EMPTY_FINANCIAL_SNAPSHOT } = await import("@/lib/chief-of-staff/financial-snapshot");
const { EMPTY_GROWTH_SNAPSHOT } = await import("@/lib/chief-of-staff/growth-snapshot");
const {
  MAX_RECURSION_DEPTH,
  MAX_SPECIALIST_FANOUT,
  isAttentionTodayQuestion,
  isJobBlockerQuestion,
  isNextWorkQuestion,
  planSpecialists,
  resolveConflicts,
  synthesizeCoachAnswer,
} = await import("@/lib/chief-of-staff");

let failures = 0;
function check(label, condition) {
  if (condition) console.log(`  ok  - ${label}`);
  else {
    console.error(`FAIL - ${label}`);
    failures += 1;
  }
}

const plannerSrc = readFileSync(new URL("../src/lib/chief-of-staff/planner.ts", import.meta.url), "utf8");
const runSrc = readFileSync(new URL("../src/lib/chief-of-staff/run.ts", import.meta.url), "utf8");
const synthesizeSrc = readFileSync(new URL("../src/lib/chief-of-staff/synthesize.ts", import.meta.url), "utf8");
const coachSrc = readFileSync(new URL("../src/lib/ai/coach.ts", import.meta.url), "utf8");
const actionSrc = readFileSync(new URL("../src/app/actions/ai.ts", import.meta.url), "utf8");

const OWNER_QUESTIONS = {
  attentionToday: "What needs my attention today?",
  workOnNext: "What should I work on next?",
  profitWeak: "Why was profit weak?",
  capacityWeek: "Do I have enough capacity this week?",
  materialsHold: "What materials are holding up jobs?",
  contactCustomer: "Did we contact this customer?",
  learnedWork: "What have we learned about this work?",
  setupUnfinished: "What business setup is unfinished?",
  protectionExpiring: "Is anything in my business protection records expiring?",
  jobBlocker: "What is stopping this job from moving forward?",
};

function mockRec(key, title, why) {
  return {
    key,
    title,
    kind: "recommendation",
    priority: 10,
    why,
    facts: [{ key: "unpaid-invoices", label: "Unpaid invoices", value: "2 / 300.00", href: "/invoices" }],
    href: "/invoices",
  };
}

function mockCatalog(recs = []) {
  return {
    facts: {
      ...EMPTY_BSOS_FACTS,
      unpaidInvoices: { count: 2, amount: 300 },
      unscheduledJobs: { count: 1 },
      availableCapacityDays: { count: 3 },
    },
    recommendations: recs,
    activeRecommendations: recs,
    historyRecommendations: [],
    states: [],
    workforceRecommendationKeys: [],
    financial: EMPTY_FINANCIAL_SNAPSHOT,
    growth: EMPTY_GROWTH_SNAPSHOT,
    workforceSnapshot: null,
  };
}

function coachContext(overrides = {}) {
  const catalog = mockCatalog(overrides.recommendations ?? []);
  return {
    facts: catalog.facts,
    recommendations: catalog.activeRecommendations,
    metrics: [],
    goals: [],
    actionItems: [],
    ...overrides,
  };
}

console.log("\nSTATIC — one advisor, no second orchestrator");
check("Max fan-out remains 4", MAX_SPECIALIST_FANOUT === 4);
check("Recursion depth remains 1", MAX_RECURSION_DEPTH === 1);
check("Planner still has no LLM", !plannerSrc.includes("runAiTask") && !plannerSrc.includes("resolveAiProvider"));
check("Coach action still uses the Chief-of-Staff runner", actionSrc.includes("runChiefOfStaffCoach") && actionSrc.includes("VIEW_REPORTS"));
check(
  "Coach path stays read/explain/recommend",
  !runSrc.includes("AiActionProposal") &&
    !coachSrc.includes("createInvoice") &&
    !synthesizeSrc.includes("markInvoice") &&
    !actionSrc.includes("publishWebsite"),
);
check(
  "System prompt forbids writes and specialist names",
  coachSystemPrompt().includes("Never name internal specialists") &&
    coachSystemPrompt().includes("cannot authorize") &&
    coachSystemPrompt().includes("Do not invent empty or zero data"),
);
check("MEMBER remains blocked from VIEW_REPORTS", !roleHasCapability("MEMBER", CAPABILITIES.VIEW_REPORTS));
check("Runner stays tenant-scoped", runSrc.includes("access.businessId") && runSrc.includes("requireBusinessCapability"));

console.log("\nPLANNER — real owner questions");
check("Attention-today classifier matches", isAttentionTodayQuestion(OWNER_QUESTIONS.attentionToday));
check("Work-on-next classifier matches", isNextWorkQuestion(OWNER_QUESTIONS.workOnNext));
check("Job-blocker classifier matches", isJobBlockerQuestion(OWNER_QUESTIONS.jobBlocker));

const attentionToday = planSpecialists({
  question: OWNER_QUESTIONS.attentionToday,
  activeRecommendationKeys: [],
});
check(
  "Attention today loads ATTENTION only",
  attentionToday.selectedIds.join(",") === "ATTENTION" && attentionToday.recursionDepth === 1,
);

const workOnNext = planSpecialists({
  question: OWNER_QUESTIONS.workOnNext,
  activeRecommendationKeys: [],
});
check("Work on next does not kitchen-sink specialists", workOnNext.selectedIds.join(",") === "ATTENTION");

const profitWeak = planSpecialists({
  question: OWNER_QUESTIONS.profitWeak,
  activeRecommendationKeys: [],
});
check(
  "Profit-weak selects FINANCIAL and not irrelevant departments",
  profitWeak.selectedIds.includes("FINANCIAL") &&
    !profitWeak.selectedIds.includes("MATERIALS") &&
    !profitWeak.selectedIds.includes("COMMUNICATIONS") &&
    !profitWeak.selectedIds.includes("BUSINESS_PROTECTION") &&
    profitWeak.fanout <= 4,
);

const capacityWeek = planSpecialists({
  question: OWNER_QUESTIONS.capacityWeek,
  activeRecommendationKeys: [],
});
check(
  "Capacity this week selects WORKFORCE only among deep departments",
  capacityWeek.selectedIds.includes("WORKFORCE") &&
    !capacityWeek.selectedIds.includes("GROWTH") &&
    !capacityWeek.selectedIds.includes("MATERIALS") &&
    !capacityWeek.selectedIds.includes("KNOWLEDGE_LAUNCH"),
);

const materialsHold = planSpecialists({
  question: OWNER_QUESTIONS.materialsHold,
  activeRecommendationKeys: [],
});
check(
  "Materials holding up jobs selects MATERIALS and not GROWTH/PROTECTION/KNOWLEDGE",
  materialsHold.selectedIds.includes("MATERIALS") &&
    !materialsHold.selectedIds.includes("GROWTH") &&
    !materialsHold.selectedIds.includes("BUSINESS_PROTECTION") &&
    !materialsHold.selectedIds.includes("KNOWLEDGE_LAUNCH"),
);

const contactCustomer = planSpecialists({
  question: OWNER_QUESTIONS.contactCustomer,
  activeRecommendationKeys: [],
});
check(
  "Contact-customer selects COMMUNICATIONS and not MATERIALS",
  contactCustomer.selectedIds.includes("COMMUNICATIONS") && !contactCustomer.selectedIds.includes("MATERIALS"),
);

const learnedWork = planSpecialists({
  question: OWNER_QUESTIONS.learnedWork,
  activeRecommendationKeys: [],
});
check(
  "Learned-work selects KNOWLEDGE_LAUNCH and not FINANCIAL",
  learnedWork.selectedIds.includes("KNOWLEDGE_LAUNCH") && !learnedWork.selectedIds.includes("FINANCIAL"),
);

const setupUnfinished = planSpecialists({
  question: OWNER_QUESTIONS.setupUnfinished,
  activeRecommendationKeys: [],
});
check(
  "Unfinished setup selects KNOWLEDGE_LAUNCH and not WORKFORCE",
  setupUnfinished.selectedIds.includes("KNOWLEDGE_LAUNCH") && !setupUnfinished.selectedIds.includes("WORKFORCE"),
);

const protectionExpiring = planSpecialists({
  question: OWNER_QUESTIONS.protectionExpiring,
  activeRecommendationKeys: [],
});
check(
  "Protection expiring selects BUSINESS_PROTECTION and not MATERIALS",
  protectionExpiring.selectedIds.includes("BUSINESS_PROTECTION") &&
    !protectionExpiring.selectedIds.includes("MATERIALS") &&
    !protectionExpiring.selectedIds.includes("GROWTH"),
);

const jobBlocker = planSpecialists({
  question: OWNER_QUESTIONS.jobBlocker,
  activeRecommendationKeys: [],
});
check(
  "Job-blocker stays at ATTENTION + WORKFORCE + MATERIALS",
  jobBlocker.selectedIds.includes("ATTENTION") &&
    jobBlocker.selectedIds.includes("WORKFORCE") &&
    jobBlocker.selectedIds.includes("MATERIALS") &&
    jobBlocker.selectedIds.length === 3 &&
    jobBlocker.fanout <= 4 &&
    !jobBlocker.selectedIds.includes("FINANCIAL") &&
    !jobBlocker.selectedIds.includes("GROWTH") &&
    !jobBlocker.selectedIds.includes("COMMUNICATIONS") &&
    !jobBlocker.selectedIds.includes("KNOWLEDGE_LAUNCH") &&
    !jobBlocker.selectedIds.includes("BUSINESS_PROTECTION"),
);

const kitchen = planSpecialists({
  question: "What should I focus on this week for invoices, staff, materials, vault, growth, and knowledge?",
  activeRecommendationKeys: ["collect-unpaid-invoices"],
});
check(
  "Kitchen-sink focus still refuses to load every specialist",
  kitchen.selectedIds.length <= 4 &&
    !kitchen.selectedIds.includes("MATERIALS") &&
    !kitchen.selectedIds.includes("BUSINESS_PROTECTION") &&
    !kitchen.selectedIds.includes("KNOWLEDGE_LAUNCH") &&
    !kitchen.selectedIds.includes("GROWTH"),
);

console.log("\nCOACH — grounded owner answers");
const recs = [
  mockRec("collect-unpaid-invoices", "Follow up on unpaid invoices", "SENT invoices are still unpaid in TBBT records."),
  mockRec("schedule-open-capacity", "Fill open schedule days", "Upcoming working days have no scheduled job on record."),
];
const attentionAnswer = answerCoachFromFacts(OWNER_QUESTIONS.attentionToday, coachContext({ recommendations: recs }));
check(
  "Attention today is one advisor list, not a single rec only",
  attentionAnswer.output.text.includes("Follow up on unpaid invoices") &&
    attentionAnswer.output.text.includes("Fill open schedule days") &&
    attentionAnswer.output.text.includes("Why it matters") &&
    attentionAnswer.output.text.includes("What you could do next"),
);
const nextAnswer = answerCoachFromFacts(OWNER_QUESTIONS.workOnNext, coachContext({ recommendations: recs }));
check(
  "Work on next uses recorded attention instead of inventing a plan",
  nextAnswer.output.text.includes("Follow up on unpaid invoices") &&
    nextAnswer.output.text.includes("does not assign"),
);
const profitAnswer = answerCoachFromFacts(OWNER_QUESTIONS.profitWeak, coachContext());
check(
  "Profit-weak stays on recorded cash vs expenses",
  profitAnswer.output.text.includes("not a bank balance") && profitAnswer.output.stance === "FACT",
);
const materialsMissing = answerCoachFromFacts(OWNER_QUESTIONS.materialsHold, coachContext());
check(
  "Materials question without a loaded specialist does not invent zero stock",
  materialsMissing.output.text.includes("not treated as zero") && !/0 stock|stock-on-hand is 0/i.test(materialsMissing.output.text),
);
const protectionMissing = answerCoachFromFacts(OWNER_QUESTIONS.protectionExpiring, coachContext());
check(
  "Protection question without a loaded specialist does not invent an empty vault",
  protectionMissing.output.text.includes("not loaded") && !/0 vault|empty vault is current/i.test(protectionMissing.output.text),
);
const commsMissing = answerCoachFromFacts(OWNER_QUESTIONS.contactCustomer, coachContext());
check(
  "Contact question without Communications facts does not invent granted consent",
  commsMissing.output.text.includes("not treated as zero messages or granted consent"),
);

console.log("\nSYNTHESIS — one voice, honest skips, deterministic conflicts");
const catalog = mockCatalog(recs);
const conflictA = resolveConflicts({
  results: [
    {
      specialistId: "ATTENTION",
      status: "OK",
      findings: [],
      factKeys: ["unpaid-invoices"],
      recommendationKeys: ["collect-unpaid-invoices"],
    },
    {
      specialistId: "MATERIALS",
      status: "OK",
      findings: [
        {
          key: "materials-stale-price",
          title: "Stale",
          summary: "A recorded material price is stale.",
          recommendationKeys: ["materials-stale-price"],
          factKeys: [],
        },
        {
          key: "materials-inventory-unknown",
          title: "Unknown inventory",
          summary: "Inventory quantity is unknown, never zero.",
          recommendationKeys: ["materials-inventory-unknown"],
          factKeys: [],
        },
      ],
      factKeys: [],
      recommendationKeys: ["materials-stale-price", "materials-inventory-unknown"],
    },
  ],
  recommendations: recs,
  facts: catalog.facts,
});
const synthesisInput = {
  question: OWNER_QUESTIONS.attentionToday,
  catalog,
  specialistResults: [
    {
      specialistId: "ATTENTION",
      status: "OK",
      findings: [],
      factKeys: ["unpaid-invoices"],
      recommendationKeys: ["collect-unpaid-invoices"],
    },
    {
      specialistId: "FINANCIAL",
      status: "FAILED",
      findings: [],
      factKeys: [],
      recommendationKeys: [],
      limitation: "Part of the recorded attention view could not be loaded. No substitute facts were invented.",
      failure: { specialistId: "FINANCIAL", message: "injected specialist failure" },
    },
  ],
  conflicts: conflictA,
  plannerSkipped: [{ id: "GROWTH", reason: "UNKNOWN_QUESTION" }],
  coachContext: coachContext({ recommendations: recs }),
};
const first = synthesizeCoachAnswer(synthesisInput);
const second = synthesizeCoachAnswer(synthesisInput);
check("Conflict handling is deterministic", first.output.text === second.output.text);
check(
  "Owner text never names an internal specialist",
  !/specialist|Finance Agent|Workforce Agent|Growth Agent/i.test(first.output.text),
);
check(
  "Failed specialist is represented honestly and does not fabricate that domain",
  /could not be loaded|surviving facts/i.test(first.output.text) &&
    !/0 profit|invented margin|bank balance is/i.test(first.output.text),
);
check(
  "Synthesis stays one answer rather than seven departmental reports",
  !/Financial report|Workforce report|Materials report|Communications report/i.test(first.output.text) &&
    first.output.text.includes("Recorded attention"),
);

const skippedAuth = synthesizeCoachAnswer({
  question: OWNER_QUESTIONS.capacityWeek,
  catalog,
  specialistResults: [
    {
      specialistId: "ATTENTION",
      status: "OK",
      findings: [],
      factKeys: ["available-capacity"],
      recommendationKeys: [],
    },
    {
      specialistId: "WORKFORCE",
      status: "SKIPPED",
      findings: [],
      factKeys: [],
      recommendationKeys: [],
      skipReason: "NOT_ENTITLED",
      limitation: "Scheduling is not available on this workspace. Missing capacity is not treated as zero workers.",
    },
  ],
  conflicts: { items: [], uniqueRecommendationKeys: [] },
  coachContext: coachContext(),
});
check(
  "Entitlement skip is spoken honestly instead of an empty roster",
  skippedAuth.output.text.includes("not available on this workspace") &&
    !/0 workers|everyone is available/i.test(skippedAuth.output.text),
);

const manyFindings = synthesizeCoachAnswer({
  question: OWNER_QUESTIONS.profitWeak,
  catalog,
  specialistResults: [
    "ATTENTION",
    "FINANCIAL",
    "WORKFORCE",
    "GROWTH",
    "MATERIALS",
    "COMMUNICATIONS",
    "KNOWLEDGE_LAUNCH",
    "BUSINESS_PROTECTION",
  ].map((specialistId, index) => ({
    specialistId,
    status: "OK",
    findings: [
      {
        key: `${specialistId.toLowerCase()}-finding`,
        title: `${specialistId} report`,
        summary: `Departmental finding ${index + 1} from recorded facts.`,
        recommendationKeys: [],
        factKeys: [],
      },
    ],
    factKeys: [],
    recommendationKeys: [],
  })),
  conflicts: { items: [], uniqueRecommendationKeys: [] },
  coachContext: coachContext(),
});
const departmentalMentions = (manyFindings.output.text.match(/Departmental finding/g) ?? []).length;
check(
  "Owner synthesis caps findings instead of repeating every departmental report",
  departmentalMentions <= 8 && departmentalMentions >= 1 && !/ATTENTION report|FINANCIAL report/.test(manyFindings.output.text),
);
check(
  "Provider payload can still keep bounded recorded findings without naming specialists",
  Array.isArray(manyFindings.payload.recordedFindings) &&
    !/Growth specialist|Finance Agent/i.test(JSON.stringify(manyFindings.payload)),
);

if (failures > 0) {
  console.error(`\n${failures} Business Coach check(s) failed.`);
  process.exit(1);
}
console.log("\nBusiness Coach routing and synthesis checks passed.");
