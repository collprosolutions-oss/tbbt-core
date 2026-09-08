/**
 * Server-side estimate PDF. Mirrors Invoice PDF presentation for
 * customer-facing fields only — never renders calculator internals.
 */
import { createWriteStream } from "node:fs";
import { existsSync } from "node:fs";
import path from "node:path";
import PDFDocument from "pdfkit";
import {
  ESTIMATE_DOCUMENT_LOGO_HEIGHT_PX,
  ESTIMATE_LABOR_SECTION_TITLE,
  ESTIMATE_MATERIALS_SECTION_TITLE,
  ESTIMATE_OTHER_SECTION_TITLE,
  ESTIMATE_TOTAL_CUSTOMER_LABEL,
  type EstimateDocumentLine,
  type EstimateDocumentView,
} from "@/lib/estimate-document";
import {
  PROJECT_CONDITIONS_TITLE,
  TERMS_AND_CONDITIONS_TITLE,
} from "@/lib/estimate-terms/types";
import {
  MATERIAL_DEPOSIT_CUSTOMER_LABEL,
  REMAINING_BALANCE_CUSTOMER_LABEL,
} from "@/lib/material-deposit";

function resolvePublicAsset(src: string | null): string | null {
  if (!src || src.includes("..")) {
    return null;
  }
  const relative = src.startsWith("/") ? src.slice(1) : src;
  const filePath = path.join(process.cwd(), "public", relative);
  return existsSync(filePath) ? filePath : null;
}

export function renderEstimatePdf(
  docView: EstimateDocumentView,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 50, compress: false });
    const chunks: Buffer[] = [];
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    const pageWidth = doc.page.width;
    const left = 50;
    const right = pageWidth - 50;
    let y = 50;

    const ensureSpace = (needed: number) => {
      if (y + needed > 720) {
        doc.addPage();
        y = 50;
      }
    };

    const logoPath = resolvePublicAsset(docView.business.logoSrc);
    if (logoPath) {
      try {
        doc.image(logoPath, left, y, { height: ESTIMATE_DOCUMENT_LOGO_HEIGHT_PX });
        y += ESTIMATE_DOCUMENT_LOGO_HEIGHT_PX + 10;
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
    if (docView.business.email) {
      doc.font("Helvetica").fontSize(10).fillColor("#333333");
      doc.text(docView.business.email, left, y, { width: 280 });
      y += 14;
    }
    if (docView.business.website) {
      doc.font("Helvetica").fontSize(10).fillColor("#333333");
      doc.text(docView.business.website, left, y, { width: 280 });
      y += 14;
    }

    const headerTop = 50;
    doc.font("Helvetica-Bold").fontSize(22).fillColor("#111111");
    doc.text("ESTIMATE", left + 300, headerTop, { width: 212, align: "right" });
    doc.font("Helvetica").fontSize(10).fillColor("#333333");
    doc.text(docView.estimateNumber, left + 300, headerTop + 28, {
      width: 212,
      align: "right",
    });
    doc.text(`Date: ${docView.estimateDateLabel}`, left + 300, headerTop + 42, {
      width: 212,
      align: "right",
    });
    doc.text(`Status: ${docView.statusLabel}`, left + 300, headerTop + 56, {
      width: 212,
      align: "right",
    });

    y = Math.max(y, headerTop + 82) + 8;
    doc.moveTo(left, y).lineTo(right, y).strokeColor("#cccccc").stroke();
    y += 18;

    doc.font("Helvetica-Bold").fontSize(9).fillColor("#666666");
    doc.text("PREPARED FOR", left, y);
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
    const colQtyPriced = right - 220;
    const colRate = right - 140;
    const colAmt = right;
    const colQtyOnly = right - 80;

    const drawSection = (
      title: string,
      lines: EstimateDocumentLine[],
      quantityOnly = false,
    ) => {
      if (lines.length === 0) return;
      const colQty = quantityOnly ? colQtyOnly : colQtyPriced;
      ensureSpace(40);
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#666666");
      doc.text(title, left, y);
      y += quantityOnly ? 10 : 16;
      doc.font("Helvetica-Bold").fontSize(8).fillColor("#666666");
      if (quantityOnly) {
        doc.text("DESCRIPTION", left, y);
        doc.text("QTY", colQty, y, { width: 70, align: "right" });
        y += 11;
      } else {
        doc.text("DESCRIPTION", left, y);
        doc.text("QTY", colQty, y, { width: 70, align: "right" });
        doc.text("RATE", colRate, y, { width: 70, align: "right" });
        doc.text("AMOUNT", colAmt - 80, y, { width: 80, align: "right" });
        y += 14;
      }
      for (const line of lines) {
        if (quantityOnly) {
          // Compact customer materials: one tight description + qty line.
          ensureSpace(16);
          const descWidth = colQty - left - 12;
          doc.font("Helvetica").fontSize(10).fillColor("#111111");
          const descHeight = doc.heightOfString(line.description, {
            width: descWidth,
          });
          const firstLineWidth = Math.min(
            descWidth,
            doc.widthOfString(line.description.split("\n")[0] ?? ""),
          );
          doc.text(line.description, left, y, { width: descWidth });
          const leaderStart = left + firstLineWidth + 4;
          const leaderEnd = colQty - 4;
          if (leaderEnd > leaderStart + 8) {
            doc.save();
            doc
              .strokeColor("#bbbbbb")
              .lineWidth(0.6)
              .dash(1, { space: 2 })
              .moveTo(leaderStart, y + 8)
              .lineTo(leaderEnd, y + 8)
              .stroke();
            doc.restore();
          }
          doc.text(line.quantityLabel, colQty, y, { width: 70, align: "right" });
          y += Math.max(12, descHeight + 1);
          continue;
        }
        ensureSpace(48);
        const descWidth = colQty - left - 12;
        const descHeight = doc.heightOfString(line.description, {
          width: descWidth,
        });
        const scope = line.includedWork?.trim() ?? "";
        const scopeHeight = scope
          ? 12 +
            doc.heightOfString(`Scope / Included Work\n${scope}`, {
              width: descWidth,
            })
          : 0;
        doc.font("Helvetica").fontSize(10).fillColor("#111111");
        doc.text(line.description, left, y, { width: descWidth });
        doc.text(line.quantityLabel, colQty, y, { width: 70, align: "right" });
        doc.text(line.unitPriceLabel, colRate, y, { width: 70, align: "right" });
        doc.text(line.amountLabel, colAmt - 80, y, { width: 80, align: "right" });
        if (scope) {
          doc.font("Helvetica-Bold").fontSize(8).fillColor("#555555");
          doc.text("Scope / Included Work", left, y + descHeight + 2, {
            width: descWidth,
          });
          doc.font("Helvetica").fontSize(8).fillColor("#333333");
          doc.text(scope, left, y + descHeight + 12, { width: descWidth });
        }
        y += Math.max(16, descHeight + scopeHeight) + 6;
      }
    };

    if (
      docView.laborLines.length === 0 &&
      docView.materialLines.length === 0 &&
      docView.otherLines.length === 0
    ) {
      doc.font("Helvetica").fontSize(10).fillColor("#666666");
      doc.text("No line items.", left, y);
      y += 18;
    } else {
      drawSection(ESTIMATE_LABOR_SECTION_TITLE, docView.laborLines);
      if (docView.laborLines.length > 0 && docView.materialLines.length > 0) {
        y += 6;
        ensureSpace(16);
        doc.moveTo(left, y).lineTo(right, y).strokeColor("#555555").lineWidth(1.5).stroke();
        doc.lineWidth(1);
        y += 14;
      }
      drawSection(ESTIMATE_MATERIALS_SECTION_TITLE, docView.materialLines, true);
      if (
        (docView.laborLines.length > 0 || docView.materialLines.length > 0) &&
        docView.otherLines.length > 0
      ) {
        y += 6;
        ensureSpace(16);
        doc.moveTo(left, y).lineTo(right, y).strokeColor("#555555").lineWidth(1.5).stroke();
        doc.lineWidth(1);
        y += 14;
      }
      drawSection(ESTIMATE_OTHER_SECTION_TITLE, docView.otherLines);
    }

    y += 8;
    ensureSpace(120);
    doc.moveTo(left, y).lineTo(right, y).strokeColor("#cccccc").stroke();
    y += 16;

    const totalsLeft = right - 280;
    const row = (label: string, value: string, bold = false) => {
      ensureSpace(20);
      const labelHeight = doc.heightOfString(label, { width: 190 });
      doc.font(bold ? "Helvetica-Bold" : "Helvetica").fontSize(10).fillColor("#111111");
      doc.text(label, totalsLeft, y, { width: 190 });
      doc.text(value, right - 80, y, { width: 80, align: "right" });
      y += Math.max(16, labelHeight + 2);
    };

    row("Labor", docView.laborTotalLabel);
    row("Materials", docView.materialTotalLabel);
    if (docView.otherTotalLabel) {
      row("Other", docView.otherTotalLabel);
    }
    if (docView.laborMinimumLabel && docView.laborMinimumAmountLabel) {
      row(docView.laborMinimumLabel, docView.laborMinimumAmountLabel);
    }
    row(ESTIMATE_TOTAL_CUSTOMER_LABEL, docView.totalLabel, true);
    if (docView.materialDepositLabel && docView.remainingBalanceLabel) {
      y += 4;
      row(MATERIAL_DEPOSIT_CUSTOMER_LABEL, docView.materialDepositLabel);
      row(REMAINING_BALANCE_CUSTOMER_LABEL, docView.remainingBalanceLabel);
      if (docView.materialDepositNote) {
        y += 4;
        ensureSpace(28);
        doc.font("Helvetica").fontSize(8).fillColor("#555555");
        doc.text(docView.materialDepositNote, left, y, { width: right - left });
        y += 16;
      }
    }

    const renderPolicyBlock = (
      heading: string,
      items: EstimateDocumentView["terms"],
    ) => {
      if (items.length === 0) return;
      y += 14;
      ensureSpace(36);
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#666666");
      doc.text(heading, left, y);
      y += 12;
      for (const policy of items) {
        const bodyHeight = doc.heightOfString(policy.body, {
          width: right - left,
        });
        ensureSpace(20 + bodyHeight);
        doc.font("Helvetica-Bold").fontSize(9).fillColor("#111111");
        doc.text(policy.title, left, y, { width: right - left });
        y += 11;
        doc.font("Helvetica").fontSize(8).fillColor("#333333");
        doc.text(policy.body, left, y, { width: right - left });
        y += bodyHeight + 8;
      }
    };

    if (docView.projectConditions) {
      y += 14;
      ensureSpace(36);
      const bodyHeight = doc.heightOfString(docView.projectConditions.body, {
        width: right - left,
      });
      ensureSpace(20 + bodyHeight);
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#666666");
      doc.text(PROJECT_CONDITIONS_TITLE, left, y);
      y += 12;
      doc.font("Helvetica").fontSize(8).fillColor("#333333");
      doc.text(docView.projectConditions.body, left, y, { width: right - left });
      y += bodyHeight + 8;
    }
    renderPolicyBlock(TERMS_AND_CONDITIONS_TITLE, docView.terms);

    y += 12;
    ensureSpace(20);
    doc.font("Helvetica").fontSize(9).fillColor("#666666");
    doc.text(`Reference: ${docView.estimateNumber}`, left, y);

    doc.end();
  });
}

/** Test helper: write a generated estimate PDF to disk. */
export async function writeEstimatePdfFile(
  docView: EstimateDocumentView,
  filePath: string,
): Promise<void> {
  const buffer = await renderEstimatePdf(docView);
  await new Promise<void>((resolve, reject) => {
    const stream = createWriteStream(filePath);
    stream.on("finish", resolve);
    stream.on("error", reject);
    stream.end(buffer);
  });
}
