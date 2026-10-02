import { createClient, SupabaseClient } from "@supabase/supabase-js";
let client: SupabaseClient | undefined;
let anonymousSignIn: Promise<void> | null = null;
export function browserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL,
    key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key)
    throw new Error(
      "Supabase is not configured. Add the environment variables in README.md.",
    );
  return (client ??= createClient(url, key));
}

export function ensureAnonymousSession(db = browserClient()) {
  if (!anonymousSignIn) {
    const pending = (async () => {
      const { data, error } = await db.auth.getSession();
      if (error) throw error;
      if (data.session) return;
      const { data: signIn, error: signInError } =
        await db.auth.signInAnonymously();
      if (signInError) throw signInError;
      if (!signIn.session) throw new Error("Anonymous sign-in returned no session");
    })();
    anonymousSignIn = pending;
  }
  const pending = anonymousSignIn;
  return pending.finally(() => {
    if (anonymousSignIn === pending) anonymousSignIn = null;
  });
}
