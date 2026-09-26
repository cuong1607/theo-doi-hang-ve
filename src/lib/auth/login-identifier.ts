// Supabase Auth signs in by email. Internal accounts may instead be given a
// plain username (e.g. "cngdv16"): it's stored as <username>@<INTERNAL_DOMAIN>
// and the login form accepts either form. Pure — shared by the login action
// and the admin bootstrap script.
export const INTERNAL_LOGIN_DOMAIN = "theodoihangve.local";

const USERNAME = /^[a-z0-9._-]{3,64}$/;

// "cngdv16" -> "cngdv16@theodoihangve.local"; a real email is returned
// as-is (lowercased). Returns null if it's neither.
export function toLoginEmail(identifier: string): string | null {
  const value = identifier.trim().toLowerCase();
  if (value.includes("@")) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null;
  }
  return USERNAME.test(value) ? `${value}@${INTERNAL_LOGIN_DOMAIN}` : null;
}

// For display: internal accounts show just the username.
export function displayLogin(email: string): string {
  const suffix = `@${INTERNAL_LOGIN_DOMAIN}`;
  return email.endsWith(suffix) ? email.slice(0, -suffix.length) : email;
}
