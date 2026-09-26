/**
 * Turn-scoped Knowledge/Launch projection counters for Chief of Staff.
 *
 * Knowledge/Launch is not loaded with the canonical catalog. The
 * specialist loads one bounded projection only when KNOWLEDGE_LAUNCH
 * is selected.
 */
let injectedLoadFailure = false;
let projectionLoadCount = 0;
let specialistInterpretationCount = 0;

export function setInjectedKnowledgeLaunchLoadFailure(value: boolean) {
  injectedLoadFailure = value;
}

export function shouldInjectKnowledgeLaunchLoadFailure() {
  return injectedLoadFailure;
}

export function recordKnowledgeLaunchProjectionLoad() {
  projectionLoadCount += 1;
}

export function getKnowledgeLaunchProjectionLoadCount() {
  return projectionLoadCount;
}

export function recordKnowledgeLaunchSpecialistInterpretation() {
  specialistInterpretationCount += 1;
}

export function getKnowledgeLaunchSpecialistInterpretationCount() {
  return specialistInterpretationCount;
}

export function resetKnowledgeLaunchSpecialistCounters() {
  specialistInterpretationCount = 0;
  projectionLoadCount = 0;
  injectedLoadFailure = false;
}
