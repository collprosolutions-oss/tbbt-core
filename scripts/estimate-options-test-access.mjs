/** Mutable test access for mocked operating-write gates. */
let currentAccess = null;

export function setTestAccess(access) {
  currentAccess = access;
}

export function getTestAccess() {
  return currentAccess;
}
