export function missingCollectionWorkItemSchema(error: unknown) {
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code?: string }).code)
      : "";
  const message = error instanceof Error ? error.message : String(error);
  return (
    code === "P2021" ||
    code === "P2022" ||
    /InvoiceCollectionWorkItem|invoiceCollectionWorkItem|does not exist/i.test(message)
  );
}
