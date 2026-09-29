export async function cookies() {
  return {
    get() {
      return undefined;
    },
    set() {},
    delete() {},
    has() {
      return false;
    },
    getAll() {
      return [];
    },
  };
}

export async function headers() {
  return new Headers();
}

export async function draftMode() {
  return { isEnabled: false };
}
