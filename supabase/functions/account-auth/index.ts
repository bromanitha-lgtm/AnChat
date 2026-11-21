import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getTrustedClientIp } from "../_shared/trusted-client-ip.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function response(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function rateLimitResponse(
  request: Request,
  admin: ReturnType<typeof createClient>,
  secret: string,
) {
  const clientIp = getTrustedClientIp(request);
  if (!clientIp) return response({ error: "Could not check account" }, 503);

  const hashInput = new TextEncoder().encode(`${secret}:${clientIp}`);
  const digest = await crypto.subtle.digest("SHA-256", hashInput);
  const keyHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  const { data: allowed, error } = await admin.rpc(
    "consume_identifier_lookup",
    { p_key_hash: keyHash },
  );
  if (error) return response({ error: "Could not check account" }, 500);
  if (!allowed) return response({ error: "Too many attempts" }, 429);
  return null;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") return response({ error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !anonKey || !serviceRoleKey) {
    return response({ error: "Server is not configured" }, 500);
  }

  let payload: {
    action?: unknown;
    identifier?: unknown;
    password?: unknown;
    email?: unknown;
    username?: unknown;
    display_name?: unknown;
  };
  try {
    payload = await request.json();
  } catch {
    return response({ error: "Invalid request" }, 400);
  }

  const admin = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  if (payload.action === "check") {
    const identifier = typeof payload.identifier === "string"
      ? payload.identifier.trim().toLowerCase()
      : "";
    if (!identifier || identifier.length > 254) {
      return response({ error: "Invalid request" }, 400);
    }
    const limited = await rateLimitResponse(request, admin, serviceRoleKey);
    if (limited) return limited;

    const { data: account, error: lookupError } = await admin.rpc(
      "resolve_login_identifier",
      { p_identifier: identifier },
    );
    if (lookupError) return response({ error: "Could not check account" }, 500);
    return response({ exists: Boolean(account?.exists) });
  }

  if (payload.action === "register") {
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    const username = typeof payload.username === "string" ? payload.username.trim().toLowerCase() : "";
    const displayName = typeof payload.display_name === "string" ? payload.display_name.trim() : "";
    const password = typeof payload.password === "string" ? payload.password : "";
    if (
      !email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      || !username || !/^(?!everyone$)[a-z0-9_]{3,24}$/.test(username)
      || !displayName || displayName.length < 2 || displayName.length > 40
      || !password || password.length < 8
    ) {
      return response({ error: "Invalid account details" }, 400);
    }

    const limited = await rateLimitResponse(request, admin, serviceRoleKey);
    if (limited) return limited;

    for (const [identifier, duplicateError] of [
      [email, "duplicate_email"],
      [username, "duplicate_handle"],
    ]) {
      const { data: account, error: lookupError } = await admin.rpc(
        "resolve_login_identifier",
        { p_identifier: identifier },
      );
      if (lookupError) return response({ error: "Could not check account" }, 500);
      if (account?.exists) return response({ error: duplicateError }, 409);
    }

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: false,
      user_metadata: { username, display_name: displayName },
    });
    if (createError || !created.user) return response({ error: "Could not create account" }, 500);

    const authClient = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { error: emailError } = await authClient.auth.resend({
      type: "signup",
      email,
    });
    if (emailError) {
      const { error: cleanupError } = await admin.auth.admin.deleteUser(created.user.id);
      if (cleanupError) console.error("Could not remove an account after verification email failure", cleanupError);
      return response({ error: "Could not send verification email" }, 503);
    }
    return response({ verification_required: true }, 202);
  }

  const identifier = typeof payload.identifier === "string"
    ? payload.identifier.trim().toLowerCase()
    : "";
  const password = typeof payload.password === "string" ? payload.password : "";
  if (payload.action !== "username-login" || !identifier || identifier.length > 254 || password.length < 8) {
    return response({ error: "Invalid login credentials" }, 401);
  }
  const limited = await rateLimitResponse(request, admin, serviceRoleKey);
  if (limited) return limited;

  const { data: account, error: lookupError } = await admin.rpc(
    "resolve_login_identifier",
    { p_identifier: identifier },
  );
  if (lookupError) return response({ error: "Could not check account" }, 500);
  if (account?.kind !== "username" || !account.email) {
    return response({ error: "Invalid login credentials" }, 401);
  }

  const authClient = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await authClient.auth.signInWithPassword({
    email: account.email,
    password,
  });
  if (error?.code === "email_not_confirmed") {
    return response({ error: "email_not_confirmed" });
  }
  if (error || !data.session) {
    return response({ error: "Invalid login credentials" }, 401);
  }

  return response({
    session: {
      access_token: data.session.access_token,
      refresh_token: data.session.refresh_token,
    },
  });
});
