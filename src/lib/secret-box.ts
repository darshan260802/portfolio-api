import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { env } from "../env.js";

/**
 * Authenticated encryption for the build-time environment variables a user
 * attaches to their own repository (`SiteEnvVar.valueCipher`).
 *
 * These are the one thing this database stores that is genuinely the
 * user's secret — an npm token, an analytics key, a headless-CMS API key —
 * and unlike a password we have to be able to read them back, so hashing
 * isn't an option. AES-256-GCM keeps them unreadable in a stray backup or
 * a `SELECT *` and, because it's authenticated, a row edited in the
 * database fails to decrypt rather than silently injecting a different
 * value into someone's build.
 *
 * The key is derived, never used raw: HKDF-SHA256 over SITE_ENV_SECRET, or
 * BETTER_AUTH_SECRET when that isn't set, with a fixed salt and a
 * feature-specific `info` string. That domain separation is what makes the
 * fallback safe — the bytes that encrypt these values are not the bytes
 * that sign sessions, even when both come from the same configured secret.
 */

const KEY_SALT = "portfolio-builder:site-env:salt:v1";
const KEY_INFO = "portfolio-builder:site-env-var-encryption:v1";
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce length
const TAG_BYTES = 16;

/** Version tag on every payload, so the format can change without a data migration. */
const FORMAT = "v1";

let cachedKey: Buffer | null = null;

function key(): Buffer {
	if (!cachedKey) {
		const secret = env.SITE_ENV_SECRET ?? env.BETTER_AUTH_SECRET;
		cachedKey = Buffer.from(hkdfSync("sha256", secret, KEY_SALT, KEY_INFO, KEY_BYTES));
	}
	return cachedKey;
}

/** Encrypts one value into a self-describing `v1:<base64>` string. */
export function encryptSecret(plaintext: string): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key(), iv);
	const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	// iv ‖ tag ‖ ciphertext — both fixed-width parts up front so decrypt can
	// slice without storing any extra metadata alongside the row.
	return `${FORMAT}:${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64")}`;
}

/**
 * Reverses `encryptSecret`. Throws on a tampered, truncated, or
 * wrong-key payload — callers treat that as "this deployment can't run"
 * rather than building with a missing variable, which would produce a
 * subtly broken site instead of an honest failure.
 */
export function decryptSecret(payload: string): string {
	const [format, encoded] = splitOnce(payload, ":");
	if (format !== FORMAT || !encoded) {
		throw new Error(`Unsupported encrypted value format: "${format}"`);
	}

	const raw = Buffer.from(encoded, "base64");
	if (raw.length < IV_BYTES + TAG_BYTES) {
		throw new Error("Encrypted value is truncated");
	}

	const decipher = createDecipheriv("aes-256-gcm", key(), raw.subarray(0, IV_BYTES));
	decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
	return Buffer.concat([
		decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
		decipher.final(),
	]).toString("utf8");
}

function splitOnce(value: string, separator: string): [string, string | undefined] {
	const at = value.indexOf(separator);
	if (at === -1) return [value, undefined];
	return [value.slice(0, at), value.slice(at + separator.length)];
}
