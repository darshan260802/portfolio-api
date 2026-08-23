import { env } from "../env.js";

/**
 * The one logging primitive for the API. In production it emits single-line
 * JSON (greppable / ingestible by any log pipeline); in development it
 * emits short coloured text. Every call site gets a scope via `.child()` so
 * production logs can be filtered per subsystem (`[builder]`, `[mail]`,
 * `[queue]`, a request id, …) without grepping raw strings.
 *
 * This exists because Phase 1 shipped with bare `console.*` calls scattered
 * across routes and services (and several code paths with *no* logging at
 * all — most importantly Resend send failures, which resolved successfully
 * from the caller's point of view). Debugging a production incident meant
 * guessing. Every mutating route and background operation now logs through
 * this.
 */

const LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const minRank = LEVEL_RANK[env.LOG_LEVEL];

const REDACT_KEYS = new Set(["password", "token", "secret", "apikey", "authorization", "cookie"]);

const ANSI: Record<LogLevel, string> = {
	debug: "\x1b[90m", // gray
	info: "\x1b[36m", // cyan
	warn: "\x1b[33m", // yellow
	error: "\x1b[31m", // red
};
const RESET = "\x1b[0m";

export type LogFields = Record<string, unknown>;

function redact(fields: LogFields): LogFields {
	const out: LogFields = {};
	for (const [key, value] of Object.entries(fields)) {
		if (REDACT_KEYS.has(key.toLowerCase())) {
			out[key] = "[redacted]";
			continue;
		}
		if (value instanceof Error) {
			out[key] = { name: value.name, message: value.message, stack: value.stack };
			continue;
		}
		out[key] = value;
	}
	return out;
}

function write(level: LogLevel, scope: string | undefined, msg: string, fields?: LogFields): void {
	if (LEVEL_RANK[level] < minRank) return;

	const safeFields = fields ? redact(fields) : undefined;
	const ts = new Date().toISOString();

	if (env.NODE_ENV === "production") {
		const line: LogFields = { ts, level, msg };
		if (scope) line.scope = scope;
		if (safeFields) Object.assign(line, safeFields);
		// One JSON object per line — parseable by any log shipper without a
		// multi-line-aware parser.
		process.stdout.write(`${JSON.stringify(line)}\n`);
		return;
	}

	const color = ANSI[level];
	const prefix = scope ? `${color}[${level}]${RESET} ${color}${scope}${RESET}` : `${color}[${level}]${RESET}`;
	const extra = safeFields && Object.keys(safeFields).length > 0 ? ` ${JSON.stringify(safeFields)}` : "";
	const target = level === "error" || level === "warn" ? console.error : console.log;
	target(`${prefix} ${msg}${extra}`);
}

export interface Logger {
	debug(msg: string, fields?: LogFields): void;
	info(msg: string, fields?: LogFields): void;
	warn(msg: string, fields?: LogFields): void;
	error(msg: string, fields?: LogFields): void;
	/** Returns a logger that prefixes every line with `scope` (and merges any base fields). */
	child(scope: string, baseFields?: LogFields): Logger;
}

function makeLogger(scope: string | undefined, baseFields: LogFields | undefined): Logger {
	return {
		debug: (msg, fields) => write("debug", scope, msg, { ...baseFields, ...fields }),
		info: (msg, fields) => write("info", scope, msg, { ...baseFields, ...fields }),
		warn: (msg, fields) => write("warn", scope, msg, { ...baseFields, ...fields }),
		error: (msg, fields) => write("error", scope, msg, { ...baseFields, ...fields }),
		child: (childScope, childFields) =>
			makeLogger(scope ? `${scope}:${childScope}` : childScope, { ...baseFields, ...childFields }),
	};
}

/** Root logger — no scope. Prefer `log.child("scope")` at each call site. */
export const log: Logger = makeLogger(undefined, undefined);
