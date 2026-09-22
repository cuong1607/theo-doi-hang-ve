import { createAdminClient } from "@/lib/supabase/admin";

export type PaymentDetail = {
  id: string;
  payment_date: string;
  total_amount: number;
  note: string | null;
  created_at: string;
  suppliers: { code: string; name: string } | null;
  profiles: { full_name: string } | null;
  payment_items: {
    id: string;
    amount: number;
    invoices: { id: string; invoice_no: string; invoice_date: string } | null;
  }[];
};

export async function getPaymentDetail(id: string): Promise<{ data: PaymentDetail | null; error: boolean }> {
  const supabase = createAdminClient();

  const { data, error } = await supabase
    .from("payments")
    .select(
      "id, payment_date, total_amount, note, created_at, suppliers(code, name), profiles(full_name), payment_items(id, amount, invoices(id, invoice_no, invoice_date))"
    )
    .eq("id", id)
    .maybeSingle();

  if (error) {
    return { data: null, error: true };
  }

  return { data: data as PaymentDetail | null, error: false };
}
