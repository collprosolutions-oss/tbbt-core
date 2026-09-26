/**
 * Turn-scoped Business Protection projection counters for Chief of Staff.
 *
 * Business Protection is not loaded with the canonical catalog. The
 * specialist loads one bounded projection only when BUSINESS_PROTECTION
 * is selected.
 */
let injectedLoadFailure = false;
let projectionLoadCount = 0;
let specialistInterpretationCount = 0;

export function setInjectedBusinessProtectionLoadFailure(value: boolean) {
  injectedLoadFailure = value;
}

export function shouldInjectBusinessProtectionLoadFailure() {
  return injectedLoadFailure;
}

export function recordBusinessProtectionProjectionLoad() {
  projectionLoadCount += 1;
}

export function getBusinessProtectionProjectionLoadCount() {
  return projectionLoadCount;
}

export function recordBusinessProtectionSpecialistInterpretation() {
  specialistInterpretationCount += 1;
}

export function getBusinessProtectionSpecialistInterpretationCount() {
  return specialistInterpretationCount;
}

export function resetBusinessProtectionSpecialistCounters() {
  specialistInterpretationCount = 0;
  projectionLoadCount = 0;
  injectedLoadFailure = false;
}
