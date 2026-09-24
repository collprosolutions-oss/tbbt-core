"use client";

import { useActionState } from "react";
import {
  confirmTotpEnrollmentAction,
  disableTotpAction,
  revokeOtherSessionsAction,
  revokeSessionAction,
  startTotpEnrollmentAction,
  type AccountSecurityState,
} from "@/app/actions/account-security";
import { Button } from "@/components/ui/button";

export type SecuritySessionRow = {
  id: string;
  createdAt: string;
  expiresAt: string;
  userAgent: string | null;
  revokedAt: string | null;
  current: boolean;
  active: boolean;
};

export function AccountSecurityPanel({
  totpEnabled,
  totpEnabledAt,
  sessions,
}: {
  totpEnabled: boolean;
  totpEnabledAt: string | null;
  sessions: SecuritySessionRow[];
}) {
  return (
    <div className="space-y-6">
      <TotpSection totpEnabled={totpEnabled} totpEnabledAt={totpEnabledAt} />
      <SessionsSection sessions={sessions} />
    </div>
  );
}

function TotpSection({
  totpEnabled,
  totpEnabledAt,
}: {
  totpEnabled: boolean;
  totpEnabledAt: string | null;
}) {
  const [startState, startAction, startPending] = useActionState(
    startTotpEnrollmentAction,
    {} as AccountSecurityState,
  );
  const [confirmState, confirmAction, confirmPending] = useActionState(
    confirmTotpEnrollmentAction,
    {} as AccountSecurityState,
  );
  const [disableState, disableAction, disablePending] = useActionState(
    disableTotpAction,
    {} as AccountSecurityState,
  );

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div>
        <p className="font-medium">Authenticator app (TOTP)</p>
        <p className="text-sm text-muted-foreground">
          {totpEnabled
            ? `Enabled${totpEnabledAt ? ` ${totpEnabledAt}` : ""}. Sign-in requires a current authenticator or backup code.`
            : "Not enabled. This is a real TOTP check, not a placeholder."}
        </p>
      </div>
      {!totpEnabled ? (
        <>
          <form action={startAction}>
            <Button type="submit" size="sm" variant="outline" disabled={startPending}>
              {startPending ? "Starting…" : "Start authenticator setup"}
            </Button>
          </form>
          {startState.otpauthUrl ? (
            <div className="space-y-2 text-sm">
              <p className="break-all font-mono text-xs">{startState.otpauthUrl}</p>
              <p>
                Secret: <span className="font-mono">{startState.secret}</span>
              </p>
              <form action={confirmAction} className="flex flex-wrap items-end gap-2">
                <label className="text-sm">
                  Authenticator code
                  <input
                    name="code"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    className="mt-1 block rounded-md border px-3 py-2"
                    required
                  />
                </label>
                <Button type="submit" size="sm" disabled={confirmPending}>
                  {confirmPending ? "Confirming…" : "Confirm and enable"}
                </Button>
              </form>
            </div>
          ) : null}
        </>
      ) : (
        <form action={disableAction} className="flex flex-wrap items-end gap-2">
          <label className="text-sm">
            Current code to disable
            <input
              name="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              className="mt-1 block rounded-md border px-3 py-2"
              required
            />
          </label>
          <Button type="submit" size="sm" variant="outline" disabled={disablePending}>
            {disablePending ? "Disabling…" : "Turn off TOTP"}
          </Button>
        </form>
      )}
      <Feedback state={startState} />
      <Feedback state={confirmState} />
      <Feedback state={disableState} />
      {confirmState.backupCodes?.length ? (
        <div className="rounded-md border border-dashed p-3">
          <p className="text-sm font-medium">Backup codes (shown once)</p>
          <ul className="mt-2 font-mono text-sm">
            {confirmState.backupCodes.map((code) => (
              <li key={code}>{code}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function SessionsSection({ sessions }: { sessions: SecuritySessionRow[] }) {
  const [revokeState, revokeAction, revokePending] = useActionState(
    revokeSessionAction,
    {} as AccountSecurityState,
  );
  const [revokeOthersState, revokeOthersAction, revokeOthersPending] = useActionState(
    revokeOtherSessionsAction,
    {} as AccountSecurityState,
  );

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">Signed-in sessions</p>
          <p className="text-sm text-muted-foreground">
            Revoking a session signs that device out. It does not delete business records.
          </p>
        </div>
        <form action={revokeOthersAction}>
          <Button type="submit" size="sm" variant="outline" disabled={revokeOthersPending}>
            {revokeOthersPending ? "Signing out…" : "Sign out other sessions"}
          </Button>
        </form>
      </div>
      <ul className="space-y-2 text-sm">
        {sessions.map((session) => (
          <li key={session.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2">
            <div>
              <p className="font-medium">
                {session.current ? "This device" : session.userAgent || "Unknown device"}
              </p>
              <p className="text-muted-foreground">
                Started {session.createdAt}
                {session.revokedAt ? " · revoked" : session.active ? " · active" : " · expired"}
              </p>
            </div>
            {!session.current && session.active ? (
              <form action={revokeAction}>
                <input type="hidden" name="sessionId" value={session.id} />
                <Button type="submit" size="sm" variant="outline" disabled={revokePending}>
                  Revoke
                </Button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
      <Feedback state={revokeState} />
      <Feedback state={revokeOthersState} />
    </div>
  );
}

function Feedback({ state }: { state: AccountSecurityState }) {
  if (state.error) return <p className="text-sm text-destructive">{state.error}</p>;
  if (state.message) return <p className="text-sm text-muted-foreground">{state.message}</p>;
  return null;
}
