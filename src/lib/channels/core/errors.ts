// Thrown by SHOPEE-0 skeletons (financial engine, provider mappers) whose
// module boundary exists but whose logic belongs to a later phase.
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} chưa được triển khai (SHOPEE-0 chỉ có khung).`);
    this.name = "NotImplementedError";
  }
}
