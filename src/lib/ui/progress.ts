// UIUX-1: progress math for SyncProgress (pure — unit tested).
// Returns null when the total is unknown (→ indeterminate bar), never a guess.
export function progressPercent(processed: number, total: number | null | undefined): number | null {
  if (total === null || total === undefined || !Number.isFinite(total) || total <= 0) return null;
  const done = Math.max(0, Math.min(processed, total));
  return Math.floor((done / total) * 100);
}
