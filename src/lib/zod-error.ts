import type { z } from "zod";

/**
 * Flattens a ZodError's `issues` into a shape a UI can actually render:
 * a human-readable `message` (the first issue) plus a `fields` map keyed
 * by dotted path, so a form can highlight the specific field that failed.
 * Every route that used to return the raw `issues` array (which nothing on
 * the client understood) should return this instead.
 */
export interface FieldErrorBody {
	message: string;
	fields: Record<string, string>;
}

export function toFieldErrors(error: z.ZodError): FieldErrorBody {
	const fields: Record<string, string> = {};
	for (const issue of error.issues) {
		const path = issue.path.join(".") || "_root";
		// First message wins per field — later issues on the same path are
		// usually follow-on noise from the first failure.
		if (!(path in fields)) fields[path] = issue.message;
	}
	const message = error.issues[0]?.message ?? "Invalid request.";
	return { message, fields };
}
