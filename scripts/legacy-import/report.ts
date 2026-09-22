import type { ParsedImport, RowIssue } from "./types.ts";
import type { DbSnapshot } from "./db.ts";
import type { ReconciliationResult } from "./reconcile.ts";

const fmt = (n: number) => n.toLocaleString("vi-VN");
const nowVN = () => new Date().toISOString();

function issuesByReason(issues: RowIssue[], reason: RowIssue["reason"]) {
  return issues.filter((i) => i.reason === reason);
}

function issueTable(issues: RowIssue[], limit = 30): string {
  if (issues.length === 0) return "_Không có._\n";
  const rows = issues
    .slice(0, limit)
    .map((i) => `| ${i.sheet} | ${i.row} | ${JSON.stringify(i.detail)} |`)
    .join("\n");
  const more = issues.length > limit ? `\n\n_...và ${issues.length - limit} dòng khác (xem import-preview.json)._` : "";
  return `| Sheet | Dòng | Chi tiết |\n| --- | --- | --- |\n${rows}${more}\n`;
}

export function buildPreviewMarkdown(parsed: ParsedImport, db: DbSnapshot): string {
  const invalid = [...issuesByReason(parsed.issues, "missing_date"), ...issuesByReason(parsed.issues, "missing_core_field")];
  const unknownSku = issuesByReason(parsed.issues, "unknown_sku");
  const unknownSupplier = issuesByReason(parsed.issues, "unknown_supplier");
  const priceConflicts = issuesByReason(parsed.issues, "duplicate_price_conflict");

  const lichSuValidRows =
    parsed.stats.lichSuTotalRows - invalid.filter((i) => i.sheet === "Lich Su").length -
    unknownSku.filter((i) => i.sheet === "Lich Su").length -
    priceConflicts.filter((i) => i.sheet === "Lich Su").length;

  const receiptItemCount = parsed.receiptGroups.reduce((s, g) => s + g.items.length, 0);
  const invoiceItemCount = parsed.invoiceGroups.reduce((s, g) => s + g.items.length, 0);

  return `# Import Preview Report — Legacy Excel

Nguồn: \`src/THEO DOI HANG VE.xlsx\` (không sửa file gốc)
Tạo lúc: ${nowVN()}

## 1. Danh Muc → suppliers / products

| | Số lượng |
| --- | --- |
| Nhà cung cấp trong sheet | ${parsed.danhMucRows.length > 0 ? db.supplierNameToCode.size : 0} |
| NCC mới cần tạo | 0 (cả 5 NCC trong sheet đã tồn tại trong DB: ${[...db.supplierNameToCode.keys()].join(", ")}) |
| Sản phẩm trong sheet | ${parsed.danhMucRows.length} |
| Sản phẩm đã có trong DB | ${db.existingProductSkus.size} |
| Sản phẩm mới cần tạo | ${parsed.newProducts.length} |
| Sản phẩm bỏ qua (hàng cũ không bán nữa, không có giá) | ${parsed.skippedProducts.length} |

### Sản phẩm mới sẽ được thêm

| SKU | Tên | Đơn vị | Giá |
| --- | --- | --- | --- |
${parsed.newProducts.map((p) => `| ${p.sku} | ${p.name} | ${p.unit} | ${fmt(p.price)} |`).join("\n")}

### Sản phẩm bỏ qua (không tạo — xác nhận là hàng cũ không còn bán)

| SKU | Tên | Đơn vị |
| --- | --- | --- |
${parsed.skippedProducts.map((p) => `| ${p.sku} | ${p.name} | ${p.unit} |`).join("\n")}

## 2. Lich Su → receipts / receipt_items

Chiến lược group (đã được người dùng xác nhận): mỗi tổ hợp **(ngày, ca, nhà cung cấp)** xuất hiện trong sheet trở thành **một phiếu nhập**,
bất kể các dòng của tổ hợp đó nằm rải rác ở đâu trong sheet (đây là giả định group cho dữ liệu legacy, không phải ràng buộc
trong DB — DB vẫn cho phép nhiều phiếu cùng ngày+ca+NCC). Nếu một SKU xuất hiện nhiều lần trong cùng tổ hợp, các dòng đó được
gộp thành 1 dòng hàng (cộng dồn SL giao / SL nhận) — chỉ gộp khi đơn giá giống nhau ở mọi lần xuất hiện.

Cột "Tổng Tiền / VAT(8%) / Tổng Tiền VAT" trong sheet **không được import vào receipt_items** — đây là tổng theo
(ngày, nhà cung cấp) gộp cả 2 ca do sheet tự tính, chỉ dùng để đối soát ở báo cáo reconciliation.

| | Số lượng |
| --- | --- |
| Tổng số dòng trong sheet (không tính dòng trống) | ${parsed.stats.lichSuTotalRows} |
| Dòng chi tiết (detail rows) | ${parsed.stats.lichSuDetailRows} |
| Dòng tổng hợp bị bỏ qua (summary rows) | 0 (sheet không có dòng "cả ngày" riêng — chỉ có các cột tổng hợp bị loại trừ như trên) |
| Không hợp lệ (Invalid — thiếu ngày/trường bắt buộc) | ${invalid.filter((i) => i.sheet === "Lich Su").length} |
| SKU lạ (Unknown SKU — không có trong Danh Muc, cần xem thủ công) | ${unknownSku.filter((i) => i.sheet === "Lich Su").length} |
| NCC lạ (Unknown supplier) | ${unknownSupplier.filter((i) => i.sheet === "Lich Su").length} |
| Trùng SKU nhưng đơn giá khác nhau (cần xem thủ công) | ${priceConflicts.filter((i) => i.sheet === "Lich Su").length} |
| Trùng SKU đã tự gộp (cùng đơn giá) | ${parsed.mergedDuplicates.length} dòng gộp vào dòng hàng đã có |
| Sẵn sàng import (valid rows) | ${lichSuValidRows} |
| → Số phiếu nhập (receipts) sẽ tạo | ${parsed.receiptGroups.length} |
| → Số dòng hàng (receipt_items) sẽ tạo | ${receiptItemCount} |

### Invalid rows

${issueTable(invalid.filter((i) => i.sheet === "Lich Su"))}

### Unknown SKU rows

${issueTable(unknownSku.filter((i) => i.sheet === "Lich Su"))}

### Unknown supplier rows

${issueTable(unknownSupplier.filter((i) => i.sheet === "Lich Su"))}

### Price-conflict duplicate rows

${issueTable(priceConflicts.filter((i) => i.sheet === "Lich Su"))}

## 3. Lich_Su_Hoa_Don → invoices / invoice_items

Chiến lược group: mỗi giá trị timestamp cột "Ngày Lưu" là một lần lưu hóa đơn → một invoice (đã kiểm chứng: mỗi nhóm
timestamp chỉ có 1 NCC + 1 ngày XH duy nhất, không có SKU trùng trong nhóm).

| | Số lượng |
| --- | --- |
| Tổng số dòng trong sheet | ${parsed.stats.hoaDonTotalRows} |
| Không hợp lệ | ${invalid.filter((i) => i.sheet === "Lich_Su_Hoa_Don").length} |
| SKU lạ | ${unknownSku.filter((i) => i.sheet === "Lich_Su_Hoa_Don").length} |
| NCC lạ | ${unknownSupplier.filter((i) => i.sheet === "Lich_Su_Hoa_Don").length} |
| → Số hóa đơn (invoices) sẽ tạo | ${parsed.invoiceGroups.length} |
| → Số dòng hàng (invoice_items) sẽ tạo | ${invoiceItemCount} |

## 4. Danh sách phiếu nhập sẽ tạo (tóm tắt)

| Ngày | Ca | NCC | Số dòng hàng | receipt_no |
| --- | --- | --- | --- | --- |
${parsed.receiptGroups
  .map((g) => `| ${g.receiptDate} | ${g.shift === "morning" ? "Sáng" : "Chiều"} | ${g.supplierName} | ${g.items.length} | ${g.receiptNo} |`)
  .join("\n")}

## 5. Danh sách hóa đơn sẽ tạo

| Ngày XH | NCC | Số dòng hàng | invoice_no |
| --- | --- | --- | --- |
${parsed.invoiceGroups.map((g) => `| ${g.invoiceDate} | ${g.supplierName} | ${g.items.length} | ${g.invoiceNo} |`).join("\n")}
`;
}

export function buildReconciliationMarkdown(parsed: ParsedImport, recon: ReconciliationResult): string {
  const mismatches = recon.dateSupplierChecks.filter((c) => !c.matches);

  return `# Import Reconciliation Report — Legacy Excel

Tạo lúc: ${nowVN()}

## Danh mục

| | |
| --- | --- |
| Số NCC | ${recon.catalogTotals.supplierCount} |
| Sản phẩm đã có trong DB | ${recon.catalogTotals.existingProductCount} |
| Sản phẩm mới sẽ thêm | ${recon.catalogTotals.newProductCount} |

## Receipts (theo receipt_items tính toán lại từ chi tiết, KHÔNG dùng cột tổng hợp trong sheet)

| | |
| --- | --- |
| Số phiếu nhập | ${recon.receiptTotals.receiptCount} |
| Số dòng hàng | ${recon.receiptTotals.itemRowCount} |
| Tổng SL giao | ${fmt(recon.receiptTotals.totalDeliveredQty)} |
| Tổng SL nhận | ${fmt(recon.receiptTotals.totalReceivedQty)} |
| Tổng chênh lệch (nhận - giao) | ${fmt(recon.receiptTotals.totalDifferenceQty)} |
| Tổng line_total | ${fmt(recon.receiptTotals.totalLineTotal)} |
| Tổng ca sáng | ${fmt(recon.receiptTotals.morningTotal)} |
| Tổng ca chiều | ${fmt(recon.receiptTotals.afternoonTotal)} |
| Sáng + Chiều (kiểm tra) | ${fmt(recon.receiptTotals.morningTotal + recon.receiptTotals.afternoonTotal)} — phải bằng Tổng line_total ở trên |

## Đối soát theo ngày + NCC (so với cột Tổng Tiền / VAT / Tổng Tiền VAT trong sheet)

Tổng ${recon.dateSupplierChecks.length} tổ hợp (ngày, NCC) có dữ liệu. **Khớp: ${recon.matchCount}. Lệch: ${recon.mismatchCount}.**

${
  mismatches.length === 0
    ? "✅ Tất cả các tổ hợp (ngày, NCC) đều khớp chính xác với tổng do sheet tự tính."
    : `⚠️ Có ${mismatches.length} tổ hợp lệch — xem chi tiết bên dưới:\n\n| Ngày | NCC | Tính từ receipt_items | Trong sheet | Lệch | Giải thích |\n| --- | --- | --- | --- | --- | --- |\n${mismatches
        .map((m) => {
          const diff = m.calculatedTotal - m.workbookTotal;
          const explained = Math.abs(diff - m.explainedByDateOverride) < 1 && m.explainedByDateOverride !== 0;
          const note = explained
            ? "✅ Do sửa ngày 1 dòng thiếu ngày (đã xác nhận với user) — sheet gốc chưa từng tính dòng này vào tổng vì để trống ngày."
            : "⚠️ Do lỗi gõ tay cột \"Thành Tiền\" trong sheet gốc — xem bảng bên dưới.";
          return `| ${m.date} | ${m.supplierName} | ${fmt(m.calculatedTotal)} | ${fmt(m.workbookTotal)} | ${fmt(diff)} | ${note} |`;
        })
        .join("\n")}`
}

### Nguyên nhân lệch (nếu có): lỗi nhập liệu trong file Excel gốc

Cột "Thành Tiền" trong Lich Su về nguyên tắc là công thức Đơn giá × SL Nhận, nhưng ${recon.sourceAnomalies.length} dòng trong
file gốc có giá trị **gõ tay khác với công thức** — đây là lỗi có sẵn trong Excel, không phải lỗi import. Toàn bộ số liệu lệch
ở bảng trên đều xuất phát từ các dòng này. Import vẫn đúng vì receipt_items.line_total luôn được tính lại từ
Đơn giá × SL Nhận, không lấy giá trị "Thành Tiền" của sheet.

${
  recon.sourceAnomalies.length === 0
    ? "_Không phát hiện dòng nào._\n"
    : `| Dòng | Ngày | NCC | SKU | Đơn giá | SL Nhận | Đơn giá×SL Nhận | "Thành Tiền" trong sheet | Lệch |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${recon.sourceAnomalies
        .map(
          (a) =>
            `| ${a.row} | ${a.date} | ${a.supplierName} | ${a.sku} | ${fmt(a.price)} | ${fmt(a.receivedQty)} | ${fmt(a.expectedThanhTien)} | ${fmt(a.sheetThanhTien)} | ${fmt(a.sheetThanhTien - a.expectedThanhTien)} |`
        )
        .join("\n")}`
}

## Invoices

| | |
| --- | --- |
| Số hóa đơn | ${recon.invoiceTotals.invoiceCount} |
| Số dòng hàng hóa đơn | ${recon.invoiceTotals.itemRowCount} |
| Tổng tiền hóa đơn | ${fmt(recon.invoiceTotals.totalAmount)} |
`;
}
