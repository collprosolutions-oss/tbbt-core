export function redirect(url) {
  const error = new Error(`NEXT_REDIRECT:${url}`);
  error.digest = `NEXT_REDIRECT;replace;${url};307;`;
  throw error;
}

export function notFound() {
  const error = new Error("NEXT_NOT_FOUND");
  error.digest = "NEXT_NOT_FOUND";
  throw error;
}
