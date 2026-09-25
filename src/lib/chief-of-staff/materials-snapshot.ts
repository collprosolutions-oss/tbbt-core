/**
 * Turn-scoped Materials projection counters for Chief of Staff.
 *
 * Materials is not loaded with the canonical catalog. The specialist
 * loads one bounded projection only when MATERIALS is selected.
 */
let injectedLoadFailure = false;
let projectionLoadCount = 0;
let specialistInterpretationCount = 0;

export function setInjectedMaterialsLoadFailure(value: boolean) {
  injectedLoadFailure = value;
}

export function shouldInjectMaterialsLoadFailure() {
  return injectedLoadFailure;
}

export function recordMaterialsProjectionLoad() {
  projectionLoadCount += 1;
}

export function getMaterialsProjectionLoadCount() {
  return projectionLoadCount;
}

export function recordMaterialsSpecialistInterpretation() {
  specialistInterpretationCount += 1;
}

export function getMaterialsSpecialistInterpretationCount() {
  return specialistInterpretationCount;
}

export function resetMaterialsSpecialistCounters() {
  specialistInterpretationCount = 0;
  projectionLoadCount = 0;
  injectedLoadFailure = false;
}
