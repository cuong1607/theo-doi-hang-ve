// PRODUCT-ANALYTICS: one read error type for every DB read of the module.
export class ProductAnalyticsReadError extends Error {
  constructor(what: string, cause?: string) {
    super(`Không đọc được ${what}${cause ? `: ${cause.slice(0, 160)}` : ""}`);
    this.name = "ProductAnalyticsReadError";
  }
}
