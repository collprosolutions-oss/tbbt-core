/**
 * Valid PDF bytes for e-sign drafts and fake signed copies.
 * pdfinfo must see a trailer; a "%PDF-1.4" text prefix is not a PDF.
 */
import PDFDocument from "pdfkit";

export function renderEsignAgreementPdf(input: {
  title?: string;
  businessId: string;
  agreementId: string;
  versionId: string;
  draftContent: string;
}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 50, compress: false });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    doc.font("Helvetica-Bold").fontSize(14).text(input.title?.trim() || "Agreement", {
      width: 500,
    });
    doc.moveDown();
    doc.font("Helvetica").fontSize(10);
    doc.text(`businessId=${input.businessId}`);
    doc.text(`agreementId=${input.agreementId}`);
    doc.text(`versionId=${input.versionId}`);
    doc.moveDown();
    doc.text(input.draftContent || "", { width: 500 });
    doc.end();
  });
}

export function esignPdfLooksValid(body: Buffer) {
  const text = body.toString("latin1");
  return (
    text.startsWith("%PDF-") &&
    text.includes("xref") &&
    text.includes("trailer") &&
    text.includes("%%EOF")
  );
}
