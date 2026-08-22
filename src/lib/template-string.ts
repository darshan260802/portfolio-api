/** Replaces every `__KEY__` placeholder in `input` with `vars.KEY`. */
export function renderPlaceholders(input: string, vars: Record<string, string>): string {
	return input.replace(/__([A-Z_]+)__/g, (match, key: string) =>
		Object.hasOwn(vars, key) ? vars[key]! : match,
	);
}
