import type { CalculatorCustomerPolicy } from "@/lib/estimate-calculators/types";
import { uniqueCustomerPolicies } from "@/lib/estimate-policies";
import { lineCustomerPolicies } from "@/lib/estimate-line-scope";

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

export function EstimateCustomerPolicies({
  descriptions,
  className,
}: {
  descriptions: Array<string | null | undefined>;
  className?: string;
}) {
  const policies = uniqueCustomerPolicies(descriptions.map(lineCustomerPolicies));
  if (policies.length === 0) return null;

  return (
    <div className={className ?? "space-y-3"}>
      <p className="text-xs font-medium text-muted-foreground">Terms</p>
      {policies.map((policy) => (
        <CustomerPolicyDisplay key={policy.id} policy={policy} className="mt-0" />
      ))}
    </div>
  );
}
