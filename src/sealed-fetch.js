// sealedFetch — every non-local https call goes through the sealwall firewall
// (PII redaction + sealed referents). No direct fallback: if sealwall is down, the call fails.
// Disable only deliberately with SEALWALL=off.
const LOCAL = /^(localhost|127\.|\[::1\]|10\.|192\.168\.)/;
const SEAL = (process.env.SEALWALL_URL || "http://127.0.0.1:8791").replace(/\/+$/, "");

export function sealedUrl(url) {
  if (process.env.SEALWALL === "off") return String(url);
  const u = new URL(String(url));
  if (u.protocol !== "https:" || LOCAL.test(u.hostname)) return String(url);
  return `${SEAL}/h/${u.host}${u.pathname}${u.search}`;
}

export function sealedFetch(input, init) {
  return fetch(typeof input === "string" || input instanceof URL ? sealedUrl(input) : input, init);
}
