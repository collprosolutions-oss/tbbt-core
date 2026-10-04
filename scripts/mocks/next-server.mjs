/**
 * Test stand-in for next/server. `after()` is a no-op here; native-push
 * tests enable TBBT_NATIVE_PUSH_TEST_FLUSH and flush explicitly.
 * NextRequest and NextResponse.redirect exist so route handlers can run
 * under node --experimental-strip-types. They are not the Next.js runtime.
 */
export function after(_task) {}

export class NextRequest extends Request {
  constructor(input, init = {}) {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    super(url, init);
    this.nextUrl = new URL(this.url);
  }
}

export class NextResponse extends Response {
  static json(body, init) {
    return new Response(JSON.stringify(body), init);
  }

  static redirect(url, status = 307) {
    const location = url instanceof URL ? url.toString() : String(url);
    return new Response(null, { status, headers: { location } });
  }
}
