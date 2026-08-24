/**
 * The wire protocol, defined once.
 *
 * This package is the single source of truth for everything that crosses a
 * network boundary. The server and the TypeScript SDK import these schemas
 * directly; the Rust agent gets serde structs generated from them (see
 * `plans/architecture.md` → "Wire protocol: one source of truth"), so the two
 * sides cannot drift apart silently.
 */

export * from "./identity.ts";
export * from "./enrollment.ts";
export * from "./session.ts";
