/**
 * Test stand-in for next/server. `after()` is a no-op here; native-push
 * tests enable TBBT_NATIVE_PUSH_TEST_FLUSH and flush explicitly.
 */
export function after(_task) {}

export class NextResponse {
  static json(body, init) {
    return new Response(JSON.stringify(body), init);
  }
}
