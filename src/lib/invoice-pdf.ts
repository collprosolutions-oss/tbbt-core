/**
 * Server-side invoice PDF. Uses pdfkit (no existing document generator
 * was in the repo). Renders the same fields as InvoiceDocumentView —
 * never invents licenses, tax, due dates, or payment methods.
 */
import { createWriteStream } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import type { InvoiceDocumentView } from "@/lib/invoice-document";

function resolvePublicAsset(src: string | null): string | null {
  if (!src || src.includes("..")) {
    return null;
  }
  const relative = src.startsWith("/") ? src.slice(1) : src;
  const filePath = path.join(process.cwd(), "public", relative);
  return existsSync(filePath) ? filePath : null;
}

export function renderInvoicePdf(
  docView: InvoiceDocumentView,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width;
    const left = 50;
    const right = pageWidth - 50;
    let y = 50;

    const logoPath = resolvePublicAsset(docView.business.logoSrc);
    if (logoPath) {
      try {
        doc.image(logoPath, left, y, { height: 42 });
        y += 52;
      } catch {
        // Missing/unreadable logo: fall through to the business name.
      }
    }

    doc.font("Helvetica-Bold").fontSize(16).fillColor("#111111");
    doc.text(docView.business.name, left, y, { width: 280 });
    y += 20;
    if (docView.business.phone) {
      doc.font("Helvetica").fontSize(10).fillColor("#333333");
      doc.text(docView.business.phone, left, y, { width: 280 });
      y += 14;
    }

    const headerTop = 50;
    doc.font("Helvetica-Bold").fontSize(22).fillColor("#111111");
    doc.text("INVOICE", left + 300, headerTop, { width: 212, align: "right" });
    doc.font("Helvetica").fontSize(10).fillColor("#333333");
    doc.text(docView.invoiceNumber, left + 300, headerTop + 28, {
      width: 212,
      align: "right",
    });
    doc.text(`Date: ${docView.invoiceDateLabel}`, left + 300, headerTop + 42, {
      width: 212,
      align: "right",
    });
    doc.text(`Status: ${docView.statusLabel}`, left + 300, headerTop + 56, {
      width: 212,
      align: "right",
    });
    if (docView.paidAtLabel) {
      doc.text(`Paid: ${docView.paidAtLabel}`, left + 300, headerTop + 70, {
        width: 212,
        align: "right",
      });
    }

    y = Math.max(y, headerTop + 96) + 8;
    doc.moveTo(left, y).lineTo(right, y).strokeColor("#cccccc").stroke();
    y += 18;

    doc.font("Helvetica-Bold").fontSize(9).fillColor("#666666");
    doc.text("BILL TO", left, y);
    y += 14;
    doc.font("Helvetica-Bold").fontSize(12).fillColor("#111111");
    doc.text(docView.customer.name || "Customer", left, y);
    y += 16;
    doc.font("Helvetica").fontSize(10).fillColor("#333333");
    if (docView.customer.email) {
      doc.text(docView.customer.email, left, y);
      y += 13;
    }
    if (docView.customer.phone) {
      doc.text(docView.customer.phone, left, y);
      y += 13;
    }
    if (docView.serviceAddress) {
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#666666");
      doc.text("SERVICE ADDRESS", left, y + 6);
      y += 18;
      doc.font("Helvetica").fontSize(10).fillColor("#333333");
      doc.text(docView.serviceAddress, left, y, { width: 360 });
      y += 16;
    }

    y += 16;
    const colQty = right - 220;
    const colRate = right - 140;
    const colAmt = right;
    doc.font("Helvetica-Bold").fontSize(8).fillColor("#666666");
    doc.text("DESCRIPTION", left, y);
    doc.text("QTY", colQty, y, { width: 70, align: "right" });
    doc.text("RATE", colRate, y, { width: 70, align: "right" });
    doc.text("AMOUNT", colAmt - 80, y, { width: 80, align: "right" });
    y += 12;
    doc.moveTo(left, y).lineTo(right, y).strokeColor("#cccccc").stroke();
    y += 10;

    if (docView.lineItems.length === 0) {
      doc.font("Helvetica").fontSize(10).fillColor("#666666");
      doc.text("No line items.", left, y);
      y += 18;
    } else {
      for (const line of docView.lineItems) {
        if (y > 680) {
          doc.addPage();
          y = 50;
        }
        const descHeight = doc.heightOfString(line.description, {
          width: colQty - left - 12,
        });
        doc.font("Helvetica").fontSize(10).fillColor("#111111");
        doc.text(line.description, left, y, { width: colQty - left - 12 });
        doc.text(line.quantityLabel, colQty, y, { width: 70, align: "right" });
        doc.text(line.unitPriceLabel, colRate, y, { width: 70, align: "right" });
        doc.text(line.amountLabel, colAmt - 80, y, { width: 80, align: "right" });
        y += Math.max(16, descHeight) + 6;
      }
    }

    y += 8;
    doc.moveTo(left, y).lineTo(right, y).strokeColor("#cccccc").stroke();
    y += 16;

    const totalsLeft = right - 220;
    const row = (label: string, value: string, bold = false) => {
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10).fillColor("#111111");
      doc.text(label, totalsLeft, y, { width: 100 });
      doc.text(value, totalsLeft + 100, y, { width: 120, align: "right" });
      y += 16;
    };

    row("Subtotal", docView.subtotalLabel);
    row("Total", docView.totalLabel, true);
    row("Payments", docView.amountPaidLabel);
    row("Amount due", docView.amountDueLabel, true);

    y += 24;
    doc.font("Helvetica").fontSize(10).fillColor("#333333");
    doc.text(docView.thankYou, left, y);
    y += 16;
    if (docView.jobReference) {
      doc.font("Helvetica").fontSize(9).fillColor("#666666");
      doc.text(
        `Reference: ${docView.invoiceNumber} · ${docView.jobReference}`,
        left,
        y,
      );
    }

    doc.end();
  });
}

/** Test helper: write a generated invoice PDF to disk. */
export async function writeInvoicePdfFile(
  docView: InvoiceDocumentView,
  filePath: string,
): Promise<void> {
  const buffer = await renderInvoicePdf(docView);
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(filePath);
    stream.on("finish", resolve);
    stream.on("error", reject);
    stream.end(buffer);
  });
}
