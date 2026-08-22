import { createClient } from "@supabase/supabase-js";
import { env } from "../env.js";

/** Service-role client — server-only, never exposed to the browser. */
export const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
	auth: { persistSession: false },
});
