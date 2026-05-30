const DANGEROUS_TAG_RE = /<\s*(script|style|iframe|object|embed|link|meta|base)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi;
const SELF_CLOSING_DANGEROUS_TAG_RE = /<\s*(script|style|iframe|object|embed|link|meta|base)[^>]*\/?\s*>/gi;
const EVENT_HANDLER_RE = /\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi;
const JS_URL_RE = /(href|src)\s*=\s*(['"]?)\s*javascript:[\s\S]*?\2/gi;

export function sanitizeAnnouncementHtml(html: string) {
  return String(html || "")
    .replace(DANGEROUS_TAG_RE, "")
    .replace(SELF_CLOSING_DANGEROUS_TAG_RE, "")
    .replace(EVENT_HANDLER_RE, "")
    .replace(JS_URL_RE, "$1=\"#\"");
}

