/**
 * Turn-scoped Communications projection counters for Chief of Staff.
 *
 * Communications is not loaded with the canonical catalog. The specialist
 * loads one bounded projection only when COMMUNICATIONS is selected.
 */
let injectedLoadFailure = false;
let projectionLoadCount = 0;
let specialistInterpretationCount = 0;

export function setInjectedCommunicationsLoadFailure(value: boolean) {
  injectedLoadFailure = value;
}

export function shouldInjectCommunicationsLoadFailure() {
  return injectedLoadFailure;
}

export function recordCommunicationsProjectionLoad() {
  projectionLoadCount += 1;
}

export function getCommunicationsProjectionLoadCount() {
  return projectionLoadCount;
}

export function recordCommunicationsSpecialistInterpretation() {
  specialistInterpretationCount += 1;
}

export function getCommunicationsSpecialistInterpretationCount() {
  return specialistInterpretationCount;
}

export function resetCommunicationsSpecialistCounters() {
  specialistInterpretationCount = 0;
  projectionLoadCount = 0;
  injectedLoadFailure = false;
}
