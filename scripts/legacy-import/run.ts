import { writeFileSync } from "node:fs";
import path from "node:path";
import { createAdminClient, loadDbSnapshot } from "./db.ts";
import { parseWorkbook } from "./parse.ts";
import { reconcile } from "./reconcile.ts";
import { buildPreviewMarkdown, buildReconciliationMarkdown } from "./report.ts";
import { importInvoices, importReceipts, insertNewProducts } from "./import.ts";

const DOCS_DIR = path.join(process.cwd(), "docs");

async function main() {
  const mode = process.argv[2] ?? "preview";
  if (mode !== "preview" && mode !== "import") {
    console.error(`Sử dụng: node --env-file=.env.local scripts/legacy-import/run.ts <preview|import>`);
    process.exit(1);
  }

  const supabase = createAdminClient();
  const dbSnapshot = await loadDbSnapshot(supabase);

  const parsed = await parseWorkbook({
    existingProductSkus: dbSnapshot.existingProductSkus,
    supplierLookup: dbSnapshot.supplierNameToCode,
  });

  const recon = await reconcile(parsed, dbSnapshot);

  const previewMd = buildPreviewMarkdown(parsed, dbSnapshot);
  const reconMd = buildReconciliationMarkdown(parsed, recon);

  writeFileSync(path.join(DOCS_DIR, "import-preview.md"), previewMd, "utf8");
  writeFileSync(path.join(DOCS_DIR, "import-reconciliation.md"), reconMd, "utf8");
  writeFileSync(
    path.join(DOCS_DIR, "import-preview.json"),
    JSON.stringify({ parsed, reconciliation: recon }, null, 2),
    "utf8"
  );

  console.log(`Đã ghi docs/import-preview.md, docs/import-reconciliation.md, docs/import-preview.json`);
  console.log(`\n=== TÓM TẮT ===`);
  console.log(`Sản phẩm mới: ${parsed.newProducts.length}`);
  console.log(`Phiếu nhập (receipts) sẽ tạo: ${parsed.receiptGroups.length}`);
  console.log(`Dòng hàng (receipt_items) sẽ tạo: ${parsed.receiptGroups.reduce((s, g) => s + g.items.length, 0)}`);
  console.log(`Hóa đơn (invoices) sẽ tạo: ${parsed.invoiceGroups.length}`);
  console.log(`Dòng hàng hóa đơn sẽ tạo: ${parsed.invoiceGroups.reduce((s, g) => s + g.items.length, 0)}`);
  console.log(`Dòng bị loại (issues): ${parsed.issues.length}`);
  console.log(`Đối soát (ngày+NCC): khớp ${recon.matchCount} / lệch ${recon.mismatchCount}`);

  if (mode === "preview") {
    console.log(`\nĐây là chế độ PREVIEW — chưa ghi gì vào database. Xem báo cáo rồi chạy lại với "import" để thực hiện.`);
    return;
  }

  console.log(`\n=== BẮT ĐẦU IMPORT ===`);

  const productResult = await insertNewProducts(supabase, parsed.newProducts, dbSnapshot.supplierNameToId);
  console.log(`Sản phẩm mới đã thêm: ${productResult.inserted}`);

  // Refresh product id map to include the ones just inserted.
  const refreshedSnapshot = await loadDbSnapshot(supabase);

  const receiptOutcomes = await importReceipts(supabase, parsed.receiptGroups, dbSnapshot.supplierNameToId, refreshedSnapshot.productSkuToId);
  const receiptInserted = receiptOutcomes.filter((o) => o.inserted).length;
  const receiptSkipped = receiptOutcomes.filter((o) => !o.inserted && !o.error).length;
  const receiptErrored = receiptOutcomes.filter((o) => o.error);
  console.log(`Receipts: đã tạo mới ${receiptInserted}, đã tồn tại (bỏ qua, idempotent) ${receiptSkipped}, lỗi ${receiptErrored.length}`);
  if (receiptErrored.length) {
    console.log(`Chi tiết lỗi receipts:`);
    for (const e of receiptErrored) console.log(`  - ${e.receiptNo} (${e.legacyRef}): ${e.error}`);
  }

  const invoiceOutcomes = await importInvoices(supabase, parsed.invoiceGroups, dbSnapshot.supplierNameToId, refreshedSnapshot.productSkuToId);
  const invoiceInserted = invoiceOutcomes.filter((o) => o.inserted).length;
  const invoiceSkipped = invoiceOutcomes.filter((o) => !o.inserted && !o.error).length;
  const invoiceErrored = invoiceOutcomes.filter((o) => o.error);
  console.log(`Invoices: đã tạo mới ${invoiceInserted}, đã tồn tại (bỏ qua, idempotent) ${invoiceSkipped}, lỗi ${invoiceErrored.length}`);
  if (invoiceErrored.length) {
    console.log(`Chi tiết lỗi invoices:`);
    for (const e of invoiceErrored) console.log(`  - ${e.invoiceNo} (${e.legacyRef}): ${e.error}`);
  }

  writeFileSync(
    path.join(DOCS_DIR, "import-run-result.json"),
    JSON.stringify({ productResult, receiptOutcomes, invoiceOutcomes }, null, 2),
    "utf8"
  );
  console.log(`\nĐã ghi docs/import-run-result.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
