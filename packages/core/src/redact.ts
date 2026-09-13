/**
 * Credential redaction. [F30]
 *
 * Source messages are stored verbatim, because they already exist in Telegram
 * and provenance depends on them. Redaction therefore happens at *render* time,
 * on every surface that quotes a message: the fact detail panel, briefs, the
 * activity panel, and any answer that quotes evidence.
 *
 * Tuned for recall, like the pre-filter and for the same reason the tradeoff is
 * asymmetric: over-redacting makes a quoted message slightly less readable,
 * while under-redacting puts a live password on a web page. When in doubt,
 * redact.
 *
 * Baton never stores a secret as a fact — only who holds one — so this function
 * is the second line of defence, not the first.
 */

export const REDACTION_PLACEHOLDER = "[redacted]";

/**
 * Ordered most specific first. A Telegram bot token would also match the
 * generic long-token rule, but matching it specifically produces a clearer
 * intent when these rules are audited.
 */
const PATTERNS: readonly RegExp[] = [
  // Telegram bot token: digits, colon, then 35 URL-safe characters.
  /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g,

  // Common API key prefixes (OpenAI, Stripe, GitHub, Slack, AWS, Google).
  /\b(?:sk|pk|rk|whsec|xox[abps]|gh[pousr]|AIza)[-_][A-Za-z0-9_-]{16,}\b/g,
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,

  // Bearer tokens and JWTs.
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,

  // Connection strings with inline credentials.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@\S+/gi,

  // PEM private key blocks.
  /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,

  // Card-shaped numbers: 13-19 digits, optionally grouped. Deliberately above
  // 12 digits so Indian mobile numbers — which this product must store and
  // display, since the emergency number is printed on two hundred posters —
  // are never touched.
  /\b(?:\d[ -]?){13,19}\b/g,
];

/**
 * Labelled secrets are handled separately from {@link PATTERNS}, before it, so
 * the label can be preserved while the value is removed. It must not also
 * appear in PATTERNS, or the second pass replaces the label too.
 */
const LABELLED_SECRET =
  /\b(password|passwd|pwd|passcode|pin|otp|cvv|secret|token|api[\s_-]?key|access[\s_-]?code)\b(\s*(?:is|are|=|:|-)?\s*)(\S+)/gi;

/**
 * Replace credential-shaped substrings with {@link REDACTION_PLACEHOLDER}.
 *
 * Safe to call on any text, including text already redacted — the placeholder
 * does not itself match any pattern, so the operation is idempotent.
 */
export function redactCredentials(text: string): string {
  if (text.length === 0) return text;

  // Labelled secrets first, preserving the label for readability.
  let out = text.replace(LABELLED_SECRET, (match, label: string, joiner: string, value: string) => {
    if (value === REDACTION_PLACEHOLDER) return match;
    return `${label}${joiner}${REDACTION_PLACEHOLDER}`;
  });

  for (const pattern of PATTERNS) {
    out = out.replace(pattern, REDACTION_PLACEHOLDER);
  }

  return out;
}

/**
 * True when redaction would change the text. Used to badge a quoted message in
 * the UI as containing a removed credential, so the reader knows the quote is
 * not literal.
 */
export function containsCredential(text: string): boolean {
  return redactCredentials(text) !== text;
}
