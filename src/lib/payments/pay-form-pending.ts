/**
 * Shared Pay Invoice / Pay Deposit form pending. The button also has its
 * own OnceSubmitButton pending; this form-level flag is what onSubmit
 * consults. After a bfcache restore the button re-enables, so this flag
 * must reset too or the next tap calls preventDefault and submits nothing.
 */

export function onPayFormPageShow(
  event: { persisted: boolean },
  setPending: (pending: boolean) => void,
) {
  if (event.persisted) setPending(false);
}

export function guardPayFormSubmit(
  pending: boolean,
  setPending: (pending: boolean) => void,
  event: { preventDefault(): void },
) {
  if (pending) {
    event.preventDefault();
    return;
  }
  setPending(true);
}
