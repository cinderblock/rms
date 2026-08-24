import {
  DEFAULT_PASSPHRASE_GROUPS,
  DEFAULT_PASSPHRASE_GROUP_SIZE,
  MIN_PASSPHRASE_LENGTH,
} from "@rmd/protocol";

/**
 * Generating and checking the shared enrollment passphrase.
 *
 * Crockford base32: no I, L, O or U, so there is nothing to misread off a screen
 * and nothing that accidentally spells a word.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * `k7m9-x2qp-4rtv-8wny-3jdc` — 20 characters, 100 bits.
 *
 * Rejection sampling rather than `% ALPHABET.length`: the modulo would bias
 * toward the first 224 of 256 byte values. The bias is small, but it is free to
 * avoid and impossible to notice once shipped.
 */
export function generatePassphrase(
  groups = DEFAULT_PASSPHRASE_GROUPS,
  groupSize = DEFAULT_PASSPHRASE_GROUP_SIZE,
): string {
  const total = groups * groupSize;
  const chars: string[] = [];
  const limit = 256 - (256 % ALPHABET.length);

  while (chars.length < total) {
    const bytes = crypto.getRandomValues(new Uint8Array(total));
    for (const byte of bytes) {
      if (byte >= limit) continue;
      chars.push(ALPHABET[byte % ALPHABET.length]!);
      if (chars.length === total) break;
    }
  }

  return Array.from({ length: groups }, (_, g) =>
    chars.slice(g * groupSize, (g + 1) * groupSize).join(""),
  )
    .join("-")
    .toLowerCase();
}

/** A URL-safe one-time token, used for the first-boot admin setup link. */
export function generateToken(bytes = 32): string {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("base64url");
}

/**
 * Normalise before hashing or comparing, so a passphrase typed with the wrong
 * case or a stray space still works. Hyphens are cosmetic grouping, so they are
 * optional to type — but this normalisation applies to admin-chosen phrases too,
 * hence stripping only leading/trailing whitespace rather than all of it.
 */
export function normalizePassphrase(input: string): string {
  return input.trim().toLowerCase();
}

export function validatePassphrase(input: string): { ok: true } | { ok: false; reason: string } {
  const normalized = normalizePassphrase(input);
  if (normalized.length < MIN_PASSPHRASE_LENGTH) {
    return {
      ok: false,
      reason: `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`,
    };
  }
  return { ok: true };
}

/**
 * Argon2id, via Bun's built-in. Memory-hard, so an offline attack on a stolen
 * database costs real hardware rather than a rented GPU-hour.
 */
export function hashPassphrase(passphrase: string): Promise<string> {
  return Bun.password.hash(normalizePassphrase(passphrase), {
    algorithm: "argon2id",
    memoryCost: 19456, // 19 MiB — OWASP's argon2id baseline
    timeCost: 2,
  });
}

export function verifyPassphrase(passphrase: string, hash: string): Promise<boolean> {
  // Bun.password.verify is constant-time with respect to the hash comparison.
  return Bun.password.verify(normalizePassphrase(passphrase), hash);
}
