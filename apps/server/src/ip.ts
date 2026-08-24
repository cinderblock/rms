/**
 * Working out who is actually talking to us.
 *
 * This matters more than it looks: the per-IP enrollment budget is only as good
 * as this function. Trusting a client-supplied `X-Forwarded-For` blindly lets an
 * attacker present a fresh IP on every request and walk straight through the
 * limiter — so XFF is ignored entirely unless the deployment says how many
 * trusted proxies sit in front, and then it is read *from the right*.
 *
 * A reverse proxy appends the peer it saw. With Caddy in front, a client that
 * sends `X-Forwarded-For: 1.2.3.4` produces `1.2.3.4, <real peer>` — so with one
 * trusted hop the real client is the last entry, and everything to its left is
 * whatever the client felt like claiming.
 */

export function clientIp(
  headers: Headers,
  peerAddress: string | null,
  trustedProxyHops: number,
): string {
  if (trustedProxyHops <= 0) return peerAddress ?? "unknown";

  const forwarded = headers.get("x-forwarded-for");
  if (forwarded === null) return peerAddress ?? "unknown";

  const chain = forwarded
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  // Index from the right by the number of proxies we actually trust. If the
  // chain is shorter than claimed, fall back to the peer rather than reaching
  // into attacker-controlled entries.
  const index = chain.length - trustedProxyHops;
  if (index < 0 || index >= chain.length) return peerAddress ?? "unknown";

  return chain[index] ?? peerAddress ?? "unknown";
}
