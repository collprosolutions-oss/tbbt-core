import { ActionForm } from "@/components/action-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { saveOwnerScenarioAssumptionSetAction } from "@/app/actions/owner-scenario-planner";
import { formatMoney } from "@/lib/format";
import {
  ASSUMPTION_SET_UNAVAILABLE_MESSAGE,
  COMPARE_SAME_FACTS_MESSAGE,
  FORECAST_DELTA_MESSAGE,
  INCOMPLETE_LABOR_MARGIN_MESSAGE,
  LABOR_WAGE_NOT_BANK_CASH_MESSAGE,
  SAVE_DOES_NOT_WRITE_BOOKS_MESSAGE,
  SAVED_SET_NOT_FACT_MESSAGE,
  SCENARIO_PLANNER_PATH,
  SET_READ_BOUND_MESSAGE,
  scenarioPlannerHref,
  type OwnerScenarioComparison,
  type OwnerScenarioPlan,
  type SavedOwnerScenarioAssumptionSet,
} from "@/lib/owner-scenario-planner";
import type { OwnerScenarioPlannerWorkspaceData } from "@/lib/owner-scenario-planner-data";

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

function signedMoney(amount: number): string {
  const formatted = formatMoney(Math.abs(amount));
  if (amount > 0) return `+${formatted}`;
  if (amount < 0) return `-${formatted}`;
  return formatted;
}

function signedPercent(amount: number | null): string {
  if (amount == null) return "Not recorded";
  if (amount > 0) return `+${amount}%`;
  return `${amount}%`;
}

const selectClassName =
  "h-8 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50";

function RecordedFactsCard({ plan }: { plan: OwnerScenarioPlan }) {
  const { recorded, messages } = plan;
  return (
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
  );
}

function ForecastGrid({
  forecast,
  unpaidMessage,
  laborCashMessage,
  incompleteLaborMessage,
}: {
  forecast: OwnerScenarioPlan["forecast"];
  unpaidMessage: string;
  laborCashMessage: string;
  incompleteLaborMessage: string;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <Fact label="Job equivalents" value={String(forecast.jobEquivalents)} />
      <Fact label="Projected billed" value={formatMoney(forecast.projectedBilledRevenue)} />
      <Fact
        label="Projected cash in"
        value={formatMoney(forecast.projectedCashIn)}
        hint={
          forecast.unpaidIncludedAsCashIn
            ? "Includes owner-assumed collection of recorded unpaid invoices."
            : unpaidMessage
        }
      />
      <Fact
        label="Projected unpaid"
        value={formatMoney(forecast.projectedUnpaidReceivable)}
        hint={forecast.unpaidIncludedAsCashIn ? "Owner assumed these collect." : unpaidMessage}
      />
      <Fact
        label="Projected wage labor"
        value={moneyOrUnavailable(forecast.projectedWageLabor)}
        hint={laborCashMessage}
      />
      <Fact label="Projected job materials" value={formatMoney(forecast.projectedJobMaterials)} />
      <Fact label="Projected cash out" value={formatMoney(forecast.projectedCashOut)} />
      <Fact
        label="Projected margin"
        value={percentOrUnavailable(forecast.projectedMarginPct)}
        hint={
          forecast.projectedGrossProfit == null
            ? incompleteLaborMessage
            : `Projected profit ${formatMoney(forecast.projectedGrossProfit)}`
        }
      />
      <Fact label="Projected known net" value={formatMoney(forecast.projectedKnownNet)} />
    </div>
  );
}

function ComparisonView({
  comparison,
}: {
  comparison: OwnerScenarioComparison;
}) {
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>Forecast comparison</CardTitle>
          <CardDescription>{COMPARE_SAME_FACTS_MESSAGE}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-2">
          <div className="space-y-3">
            <p className="text-sm font-medium">{comparison.left.set.name}</p>
            <p className="text-xs text-muted-foreground">
              Workload {comparison.left.assumptions.workloadPercent}% · Price{" "}
              {comparison.left.assumptions.pricePercent}% · Materials{" "}
              {comparison.left.assumptions.materialCostPercent}% · Labor{" "}
              {comparison.left.assumptions.laborCostPercent}%
              {comparison.left.assumptions.assumeUnpaidInvoicesCollect
                ? " · assume unpaid collect"
                : ""}
            </p>
            <ForecastGrid
              forecast={comparison.left.forecast}
              unpaidMessage={comparison.messages.unpaid}
              laborCashMessage={LABOR_WAGE_NOT_BANK_CASH_MESSAGE}
              incompleteLaborMessage={INCOMPLETE_LABOR_MARGIN_MESSAGE}
            />
          </div>
          <div className="space-y-3">
            <p className="text-sm font-medium">{comparison.right.set.name}</p>
            <p className="text-xs text-muted-foreground">
              Workload {comparison.right.assumptions.workloadPercent}% · Price{" "}
              {comparison.right.assumptions.pricePercent}% · Materials{" "}
              {comparison.right.assumptions.materialCostPercent}% · Labor{" "}
              {comparison.right.assumptions.laborCostPercent}%
              {comparison.right.assumptions.assumeUnpaidInvoicesCollect
                ? " · assume unpaid collect"
                : ""}
            </p>
            <ForecastGrid
              forecast={comparison.right.forecast}
              unpaidMessage={comparison.messages.unpaid}
              laborCashMessage={LABOR_WAGE_NOT_BANK_CASH_MESSAGE}
              incompleteLaborMessage={INCOMPLETE_LABOR_MARGIN_MESSAGE}
            />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>Forecast difference</CardTitle>
          <CardDescription>{FORECAST_DELTA_MESSAGE}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Fact
            label="Projected billed"
            value={signedMoney(comparison.deltas.billed)}
            hint={comparison.deltas.message}
          />
          <Fact label="Projected cash in" value={signedMoney(comparison.deltas.cashIn)} />
          <Fact label="Projected cash out" value={signedMoney(comparison.deltas.cashOut)} />
          <Fact label="Projected known net" value={signedMoney(comparison.deltas.knownNet)} />
          <Fact label="Projected margin" value={signedPercent(comparison.deltas.marginPct)} />
        </CardContent>
      </Card>
    </div>
  );
}

function SavedSetsCard({
  savedSets,
  setsTruncated,
  setsAvailable,
  openedSet,
  comparison,
  comparisonError,
  plan,
}: {
  savedSets: SavedOwnerScenarioAssumptionSet[];
  setsTruncated: boolean;
  setsAvailable: boolean;
  openedSet: SavedOwnerScenarioAssumptionSet | null;
  comparison: OwnerScenarioComparison | null;
  comparisonError: string | null;
  plan: OwnerScenarioPlan;
}) {
  const { assumptions } = plan;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Named assumption sets</CardTitle>
        <CardDescription>
          Save owner knobs, reopen them against current recorded facts, or
          compare two forecasts on the same fact sample. {SAVED_SET_NOT_FACT_MESSAGE}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!setsAvailable ? <p className="text-sm text-muted-foreground">{ASSUMPTION_SET_UNAVAILABLE_MESSAGE}</p> : null}
        <ActionForm action={saveOwnerScenarioAssumptionSetAction} className="grid gap-3 sm:grid-cols-2">
          <input type="hidden" name="workload" value={String(assumptions.workloadPercent)} />
          <input type="hidden" name="materials" value={String(assumptions.materialCostPercent)} />
          <input type="hidden" name="labor" value={String(assumptions.laborCostPercent)} />
          <input type="hidden" name="price" value={String(assumptions.pricePercent)} />
          {assumptions.assumeUnpaidInvoicesCollect ? (
            <input type="hidden" name="assumeUnpaid" value="1" />
          ) : null}
          <label className="grid gap-1 text-sm sm:col-span-2">
            Name
            <Input
              name="name"
              maxLength={80}
              defaultValue={openedSet?.name ?? ""}
              placeholder="Busy summer"
            />
          </label>
          <div className="sm:col-span-2">
            <Button type="submit">Save assumption set</Button>
          </div>
        </ActionForm>
        <p className="text-sm text-muted-foreground">{SAVE_DOES_NOT_WRITE_BOOKS_MESSAGE}</p>

        {savedSets.length > 0 ? (
          <ul className="space-y-2">
            {savedSets.map((set) => (
              <li key={set.id} className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span>
                  <span className="font-medium">{set.name}</span>
                  <span className="text-muted-foreground">
                    {" "}
                    · workload {set.workloadPercent}% · price {set.pricePercent}%
                    {openedSet?.id === set.id ? " · open" : ""}
                  </span>
                </span>
                <a
                  href={scenarioPlannerHref({ set: set.id })}
                  className="text-sm font-medium text-primary underline-offset-4 hover:underline"
                >
                  Reopen
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted-foreground">No named assumption sets saved yet.</p>
        )}
        {setsTruncated ? <p className="text-sm text-muted-foreground">{SET_READ_BOUND_MESSAGE}</p> : null}

        {savedSets.length >= 2 ? (
          <form method="get" action={SCENARIO_PLANNER_PATH} className="grid gap-3 sm:grid-cols-2">
            <label className="grid gap-1 text-sm">
              First assumption set
              <select
                name="left"
                defaultValue={comparison?.left.set.id ?? savedSets[0]?.id}
                className={selectClassName}
              >
                {savedSets.map((set) => (
                  <option key={set.id} value={set.id}>
                    {set.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="grid gap-1 text-sm">
              Second assumption set
              <select
                name="right"
                defaultValue={comparison?.right.set.id ?? savedSets[1]?.id}
                className={selectClassName}
              >
                {savedSets.map((set) => (
                  <option key={set.id} value={set.id}>
                    {set.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="sm:col-span-2">
              <Button type="submit">Compare forecasts</Button>
            </div>
          </form>
        ) : null}
        {comparisonError ? <p className="text-sm text-destructive">{comparisonError}</p> : null}
      </CardContent>
    </Card>
  );
}

export function OwnerScenarioPlannerWorkspace({
  workspace,
}: {
  workspace: OwnerScenarioPlannerWorkspaceData;
}) {
  const { plan, savedSets, setsTruncated, setsAvailable, openedSet, comparison, comparisonError } =
    workspace;
  const { forecast, assumptions, messages } = plan;

  return (
    <div className="space-y-4">
      <SavedSetsCard
        savedSets={savedSets}
        setsTruncated={setsTruncated}
        setsAvailable={setsAvailable}
        openedSet={openedSet}
        comparison={comparison}
        comparisonError={comparisonError}
        plan={plan}
      />

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
            {openedSet ? <input type="hidden" name="set" value={openedSet.id} /> : null}
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
          {openedSet ? (
            <p className="mt-3 text-sm text-muted-foreground">
              Reopened {openedSet.name}. {SAVED_SET_NOT_FACT_MESSAGE}
            </p>
          ) : null}
          <p className="mt-3 text-sm text-muted-foreground">{messages.prices}</p>
        </CardContent>
      </Card>

      <RecordedFactsCard plan={plan} />

      {comparison ? (
        <ComparisonView comparison={comparison} />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Forecast scenario</CardTitle>
            <CardDescription>{messages.forecast}</CardDescription>
          </CardHeader>
          <CardContent>
            <ForecastGrid
              forecast={forecast}
              unpaidMessage={messages.unpaid}
              laborCashMessage={messages.laborCash}
              incompleteLaborMessage={messages.incompleteLabor}
            />
          </CardContent>
        </Card>
      )}

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
          <p>{SAVE_DOES_NOT_WRITE_BOOKS_MESSAGE}</p>
          {messages.bound ? <p>{messages.bound}</p> : null}
        </CardContent>
      </Card>
    </div>
  );
}
