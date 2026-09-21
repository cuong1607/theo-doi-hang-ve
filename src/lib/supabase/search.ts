// Escapes ILIKE wildcard characters so user search input can't be
// interpreted as unintended pattern matching.
export function escapeIlikeTerm(value: string) {
  return value.replace(/[%_]/g, (m) => `\\${m}`);
}
