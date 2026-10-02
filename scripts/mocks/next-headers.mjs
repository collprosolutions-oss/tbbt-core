const testCookies = new Map();

export function setTestCookies(entries) {
  testCookies.clear();
  for (const [name, value] of Object.entries(entries ?? {})) {
    if (value != null) testCookies.set(name, String(value));
  }
}

export async function cookies() {
  return {
    get(name) {
      const value = testCookies.get(name);
      return value == null ? undefined : { value };
    },
    set() {},
    delete() {},
    has(name) {
      return testCookies.has(name);
    },
    getAll() {
      return [...testCookies.entries()].map(([name, value]) => ({ name, value }));
    },
  };
}

export async function headers() {
  return new Headers();
}

export async function draftMode() {
  return { isEnabled: false };
}
