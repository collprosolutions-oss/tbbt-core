import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatMoney } from "@/lib/format";
import {
  SCENARIO_PLANNER_PATH,
  type OwnerScenarioPlan,
} from "@/lib/owner-scenario-planner";

function Fact({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div>
      <p className="text-xs uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-medium tabular-nums">{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function moneyOrUnavailable(amount: number | null): string {
  return amount == null ? "Not recorded" : formatMoney(amount);
}

function percentOrUnavailable(amount: number | null): string {
  return amount == null ? "Not recorded" : `${amount}%`;
}

export function OwnerScenarioPlannerWorkspace({ plan }: { plan: OwnerScenarioPlan }) {
  const { recorded, forecast, assumptions, messages } = plan;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Owner assumptions</CardTitle>
          <CardDescription>
            Percent fields are overlays on recorded facts. 100 keeps the recorded
            amount. Submitting this form only refreshes the forecast. It does not
            change prices or write financial records.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form method="get" action={SCENARIO_PLANNER_PATH} className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">
              Workload %
              <Input
                name="workload"
                type="number"
                inputMode="decimal"
                min={0}
                max={500}
                step="0.1"
                defaultValue={String(assumptions.workloadPercent)}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Price %
              <Input
                name="price"
                type="number"
                inputMode="decimal"
                min={0}
                max={500}
                step="0.1"
                defaultValue={String(assumptions.pricePercent)}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Material cost assumption %
              <Input
                name="materials"
                type="number"
                inputMode="decimal"
                min={0}
                max={500}
                step="0.1"
                defaultValue={String(assumptions.materialCostPercent)}
              />
            </label>
            <label className="grid gap-1 text-sm">
              Labor cost assumption %
              <Input
                name="labor"
                type="number"
                inputMode="decimal"
                min={0}
                max={500}
                step="0.1"
                defaultValue={String(assumptions.laborCostPercent)}
              />
            </label>
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input
                type="checkbox"
                name="assumeUnpaid"
                value="1"
                defaultChecked={assumptions.assumeUnpaidInvoicesCollect}
                className="size-4"
              />
              Forecast only: assume recorded unpaid invoices collect
            </label>
            <div className="sm:col-span-2">
              <Button type="submit">Recalculate forecast</Button>
            </div>
          </form>
          {assumptions.errors.length > 0 ? (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-destructive">
              {assumptions.errors.map((error) => (
                <li key={error}>{error}</li>
              ))}
            </ul>
          ) : null}
          <p className="mt-3 text-sm text-muted-foreground">{messages.prices}</p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recorded facts</CardTitle>
          <CardDescription>
            These values come from recorded job profitability, invoice payments,
            and expenses. They are not forecasts.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Jobs in sample" value={String(recorded.jobCount)} />
          <Fact label="Billed revenue" value={formatMoney(recorded.billedRevenue)} />
          <Fact
            label="Collected payments"
            value={formatMoney(recorded.collectedRevenue)}
            hint="Recorded cash in"
          />
          <Fact
            label="Unpaid invoices"
            value={formatMoney(recorded.unpaidReceivable)}
            hint={messages.unpaid}
          />
          <Fact
            label="Recorded wage labor"
            value={moneyOrUnavailable(recorded.recordedWageLabor)}
            hint={messages.laborCash}
          />
          <Fact label="Job materials" value={formatMoney(recorded.jobMaterialsExpense)} />
          <Fact label="Other job expenses" value={formatMoney(recorded.jobOtherExpense)} />
          <Fact
            label="Unallocated expenses"
            value={formatMoney(recorded.overheadExpense)}
            hint={messages.overhead}
          />
          <Fact
            label="Recorded gross margin"
            value={percentOrUnavailable(recorded.recordedMarginPct)}
            hint={
              recorded.incompleteLaborJobCount > 0
                ? `${messages.incompleteLabor} ${recorded.incompleteLaborJobCount} job(s) lack recorded labor cost.`
                : recorded.recordedGrossProfit == null
                  ? messages.incompleteLabor
                  : `Recorded profit ${formatMoney(recorded.recordedGrossProfit)}`
            }
          />
          <Fact label="Known cash in" value={formatMoney(recorded.knownCashIn)} />
          <Fact label="Known cash out" value={formatMoney(recorded.knownCashOut)} />
          <Fact label="Known net" value={formatMoney(recorded.knownNet)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Forecast scenario</CardTitle>
          <CardDescription>{messages.forecast}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Fact label="Job equivalents" value={String(forecast.jobEquivalents)} />
          <Fact label="Projected billed" value={formatMoney(forecast.projectedBilledRevenue)} />
          <Fact
            label="Projected cash in"
            value={formatMoney(forecast.projectedCashIn)}
            hint={
              forecast.unpaidIncludedAsCashIn
                ? "Includes owner-assumed collection of recorded unpaid invoices."
                : messages.unpaid
            }
          />
          <Fact
            label="Projected unpaid"
            value={formatMoney(forecast.projectedUnpaidReceivable)}
            hint={forecast.unpaidIncludedAsCashIn ? "Owner assumed these collect." : messages.unpaid}
          />
          <Fact
            label="Projected wage labor"
            value={moneyOrUnavailable(forecast.projectedWageLabor)}
            hint={messages.laborCash}
          />
          <Fact label="Projected job materials" value={formatMoney(forecast.projectedJobMaterials)} />
          <Fact label="Projected cash out" value={formatMoney(forecast.projectedCashOut)} />
          <Fact
            label="Projected margin"
            value={percentOrUnavailable(forecast.projectedMarginPct)}
            hint={
              forecast.projectedGrossProfit == null
                ? messages.incompleteLabor
                : `Projected profit ${formatMoney(forecast.projectedGrossProfit)}`
            }
          />
          <Fact label="Projected known net" value={formatMoney(forecast.projectedKnownNet)} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>What this is not</CardTitle>
          <CardDescription>Honesty limits for this planner.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>{messages.bank}</p>
          <p>{messages.bankingConnection}</p>
          <p>{messages.accounting}</p>
          <p>{messages.tax}</p>
          <p>{messages.prices}</p>
          {messages.bound ? <p>{messages.bound}</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}
