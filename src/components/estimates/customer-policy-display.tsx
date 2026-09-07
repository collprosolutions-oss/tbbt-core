import type { CalculatorCustomerPolicy } from "@/lib/estimate-calculators/types";
import { uniqueCustomerPolicies } from "@/lib/estimate-policies";
import { lineCustomerPolicies } from "@/lib/estimate-line-scope";
import { partitionEstimateTerms } from "@/lib/estimate-terms/compose";
import {
  PROJECT_CONDITIONS_TITLE,
  TERMS_AND_CONDITIONS_TITLE,
} from "@/lib/estimate-terms/types";

export function CustomerPolicyDisplay({
  policy,
  className,
}: {
  policy: CalculatorCustomerPolicy;
  className?: string;
}) {
  return (
    <div className={className ?? "mt-2"}>
      <p className="text-xs font-medium text-muted-foreground">{policy.title}</p>
      <p className="mt-1 whitespace-pre-line text-sm">{policy.body}</p>
    </div>
  );
}

export function EstimateDocumentTerms({
  projectConditions,
  terms,
  appearance = "web",
  className,
}: {
  projectConditions?: { title: string; body: string } | null;
  terms?: Array<{ title: string; body: string }>;
  appearance?: "web" | "print";
  className?: string;
}) {
  const heading =
    appearance === "print"
      ? "text-xs font-semibold tracking-wider text-neutral-500"
      : "text-xs font-semibold tracking-wider text-muted-foreground";
  const titleClass =
    appearance === "print"
      ? "font-medium text-neutral-800"
      : "font-medium";
  const bodyClass =
    appearance === "print"
      ? "mt-0.5 whitespace-pre-line text-[11px] leading-snug text-neutral-600"
      : "mt-0.5 whitespace-pre-line text-xs leading-snug text-muted-foreground";

  if (!projectConditions && (!terms || terms.length === 0)) return null;

  return (
    <div className={className ?? "space-y-4"}>
      {projectConditions ? (
        <section>
          <h2 className={heading}>{PROJECT_CONDITIONS_TITLE}</h2>
          {projectConditions.title !== PROJECT_CONDITIONS_TITLE ? (
            <p className={`mt-2 ${titleClass}`}>{projectConditions.title}</p>
          ) : null}
          <p className={`${projectConditions.title !== PROJECT_CONDITIONS_TITLE ? "" : "mt-2 "}${bodyClass}`}>
            {projectConditions.body}
          </p>
        </section>
      ) : null}
      {terms && terms.length > 0 ? (
        <section>
          <h2 className={heading}>{TERMS_AND_CONDITIONS_TITLE}</h2>
          <div className="mt-2 space-y-2.5">
            {terms.map((policy) => (
              <div key={policy.title}>
                <p className={titleClass}>{policy.title}</p>
                <p className={bodyClass}>{policy.body}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

export function EstimateCustomerPolicies({
  descriptions,
  policies: givenPolicies,
  projectConditions,
  terms,
  className,
  appearance = "web",
}: {
  descriptions?: Array<string | null | undefined>;
  policies?: Array<{ id?: string; title: string; body: string }>;
  projectConditions?: { title: string; body: string } | null;
  terms?: Array<{ title: string; body: string }>;
  className?: string;
  appearance?: "web" | "print";
}) {
  if (projectConditions !== undefined || terms !== undefined) {
    return (
      <EstimateDocumentTerms
        className={className}
        appearance={appearance}
        projectConditions={projectConditions}
        terms={terms ?? []}
      />
    );
  }

  const policies =
    givenPolicies?.map((policy, index) => ({
      id: policy.id ?? `policy-${index}`,
      title: policy.title,
      body: policy.body,
    })) ?? uniqueCustomerPolicies((descriptions ?? []).map(lineCustomerPolicies));
  if (policies.length === 0) return null;
  const partitioned = partitionEstimateTerms(policies);

  return (
    <EstimateDocumentTerms
      className={className}
      appearance={appearance}
      projectConditions={partitioned.projectConditions}
      terms={partitioned.terms}
    />
  );
}
