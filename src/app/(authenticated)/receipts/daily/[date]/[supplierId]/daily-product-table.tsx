import { formatCurrency } from "@/lib/format";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export type DailyTableRow = {
  productId: string;
  sku: string;
  name: string;
  unit: string;
  delivered: number;
  received: number;
  difference: number;
  lineTotal: number;
  unitPrices?: number[] | null;
};

function priceCellText(prices: number[] | null | undefined) {
  if (!prices || prices.length === 0) return "—";
  if (prices.length === 1) return formatCurrency(prices[0]);
  return "Nhiều mức giá";
}

export function DailyProductTable({
  title,
  rows,
  showUnitPrice,
  emptyMessage,
  showSummary = true,
}: {
  title: string;
  rows: DailyTableRow[];
  showUnitPrice: boolean;
  emptyMessage: string;
  // The Cả ngày table's summary includes VAT and is rendered by the page
  // itself right after — suppress this table's own plain summary there to
  // avoid showing the same totals twice.
  showSummary?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <div>
        <h3 className="mb-2 font-medium">{title}</h3>
        <p className="py-8 text-center text-sm text-muted-foreground">{emptyMessage}</p>
      </div>
    );
  }

  const totalDelivered = rows.reduce((sum, r) => sum + r.delivered, 0);
  const totalReceived = rows.reduce((sum, r) => sum + r.received, 0);
  const totalDifference = rows.reduce((sum, r) => sum + r.difference, 0);
  const totalAmount = rows.reduce((sum, r) => sum + r.lineTotal, 0);

  return (
    <div className="space-y-3">
      <h3 className="font-medium">{title}</h3>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>SKU</TableHead>
            <TableHead>Tên sản phẩm</TableHead>
            <TableHead>Đơn vị</TableHead>
            {showUnitPrice && <TableHead>Đơn giá</TableHead>}
            <TableHead>SL giao</TableHead>
            <TableHead>SL nhận</TableHead>
            <TableHead>Chênh lệch</TableHead>
            <TableHead>Thành tiền</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.productId}>
              <TableCell className="font-medium">{row.sku}</TableCell>
              <TableCell>{row.name}</TableCell>
              <TableCell>{row.unit}</TableCell>
              {showUnitPrice && <TableCell>{priceCellText(row.unitPrices)}</TableCell>}
              <TableCell>{row.delivered}</TableCell>
              <TableCell>{row.received}</TableCell>
              <TableCell className={row.difference < 0 ? "text-destructive" : undefined}>
                {row.difference}
              </TableCell>
              <TableCell>{formatCurrency(row.lineTotal)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {showSummary && (
        <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-4">
          <SummaryField label="Tổng SL giao" value={String(totalDelivered)} />
          <SummaryField label="Tổng SL nhận" value={String(totalReceived)} />
          <SummaryField
            label="Tổng chênh lệch"
            value={String(totalDifference)}
            emphasis={totalDifference < 0}
          />
          <SummaryField label="Tổng tiền" value={formatCurrency(totalAmount)} />
        </div>
      )}
    </div>
  );
}

export function SummaryField({
  label,
  value,
  emphasis,
  strong,
}: {
  label: string;
  value: string;
  emphasis?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="space-y-0.5">
      <p className="text-muted-foreground">{label}</p>
      <p
        className={
          strong
            ? "text-base font-semibold"
            : emphasis
              ? "font-medium text-destructive"
              : "font-medium"
        }
      >
        {value}
      </p>
    </div>
  );
}
