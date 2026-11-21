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

function escapeHtml(value: string) {
  const escapedCharacters: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  };
  return value.replace(/[&<>"']/g, (character) => escapedCharacters[character] ?? character);
}

async function consumeEmailRateLimit(request: Request, admin: ReturnType<typeof createClient>, secret: string) {
  const clientIp = getTrustedClientIp(request);
  if (!clientIp) return { data: null, error: new Error("Trusted client address is unavailable") };

  const hashInput = new TextEncoder().encode(`notification-email:${secret}:${clientIp}`);
  const digest = await crypto.subtle.digest("SHA-256", hashInput);
  const keyHash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
  return await admin.rpc("consume_identifier_lookup", { p_key_hash: keyHash });
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") return response({ error: "Method not allowed" }, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const resendApiKey = Deno.env.get("RESEND_API_KEY");
  const emailFrom = Deno.env.get("EMAIL_FROM");
  const appUrl = Deno.env.get("APP_URL");
  if (!supabaseUrl || !serviceRoleKey || !resendApiKey || !emailFrom || !appUrl) {
    return response({ error: "Notification email is not configured" }, 503);
  }

  let appBaseUrl: URL;
  try {
    appBaseUrl = new URL(appUrl);
  } catch {
    return response({ error: "Notification email is not configured" }, 503);
  }
  if (appBaseUrl.protocol !== "https:" && appBaseUrl.protocol !== "http:") {
    return response({ error: "Notification email is not configured" }, 503);
  }

  let payload: { question_id?: unknown };
  try {
    payload = await request.json();
  } catch {
    return response({ error: "Invalid request body" }, 400);
  }
  const questionId = payload.question_id;
  if (typeof questionId !== "string" || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(questionId)) {
    return response({ error: "Invalid question" }, 400);
  }

  const admin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data: allowed, error: rateLimitError } = await consumeEmailRateLimit(request, admin, serviceRoleKey);
  if (rateLimitError) {
    console.error("Could not check notification email rate limit", rateLimitError.message);
    return response({ error: "Could not send notifications" }, 500);
  }
  if (!allowed) return response({ error: "Too many notification requests" }, 429);

  const staleSendingBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const { data: claimed, error: claimError } = await admin
    .from("notifications")
    .update({ email_status: "sending", email_started_at: new Date().toISOString() })
    .eq("question_id", questionId)
    .or(`email_status.eq.pending,and(email_status.eq.sending,email_started_at.lt.${staleSendingBefore})`)
    .select("id, recipient_id, kind");
  if (claimError) {
    console.error("Could not claim notification emails", claimError.message);
    return response({ error: "Could not send notifications" }, 500);
  }
  if (!claimed?.length) return response({ sent: 0 });

  const notificationIds = claimed.map((notification) => notification.id);
  const [questionResult, answerResult] = await Promise.all([
    admin
      .from("questions")
      .select("body, target_profile_id")
      .eq("id", questionId)
      .maybeSingle(),
    admin
      .from("answers")
      .select("body")
      .eq("question_id", questionId)
      .maybeSingle(),
  ]);
  const needsAnswer = claimed.some((notification) => notification.kind === "answer");
  if (questionResult.error || !questionResult.data || (needsAnswer && answerResult.error)) {
    if (questionResult.error) console.error("Could not load question notification content", questionResult.error.message);
    if (needsAnswer && answerResult.error) console.error("Could not load answer notification content", answerResult.error.message);
    const { error } = await admin
      .from("notifications")
      .update({ email_status: "failed", email_started_at: null })
      .in("id", notificationIds);
    if (error) console.error("Could not update notification email status", error.message);
    return response({ error: "Could not send notifications" }, 500);
  }

  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("display_name, public_id")
    .eq("id", questionResult.data.target_profile_id)
    .maybeSingle();
  if (profileError || !profile) {
    const { error } = await admin
      .from("notifications")
      .update({ email_status: "failed", email_started_at: null })
      .in("id", notificationIds);
    if (error) console.error("Could not update notification email status", error.message);
    return response({ error: "Could not send notifications" }, 500);
  }

  const profileUrl = new URL(appBaseUrl);
  profileUrl.search = "";
  profileUrl.hash = "questions";
  profileUrl.searchParams.set("to", profile.public_id);
  let sent = 0;
  const failedIds: string[] = [];

  for (const notification of claimed) {
    const { data: userResult, error: userError } = await admin.auth.admin.getUserById(notification.recipient_id);
    const email = userResult.user?.email;
    const answerBody = answerResult.data?.body ?? "";
    if (userError || !email || (notification.kind === "answer" && !answerBody)) {
      failedIds.push(notification.id);
      continue;
    }

    const isNewQuestion = notification.kind === "new_question";
    const subjectName = profile.display_name.replace(/[\r\n]+/g, " ").slice(0, 100);
    const subject = isNewQuestion
      ? `A new question for ${subjectName}`
      : `Your question received a reply`;
    const title = isNewQuestion ? "You received a new question" : "Your question received a reply";
    const detail = isNewQuestion
      ? `<p style="white-space:pre-wrap">${escapeHtml(questionResult.data.body)}</p>`
      : `<p><strong>Your question</strong></p><p style="white-space:pre-wrap">${escapeHtml(questionResult.data.body)}</p><p><strong>Reply</strong></p><p style="white-space:pre-wrap">${escapeHtml(answerBody)}</p>`;
    const escapedProfileName = escapeHtml(profile.display_name);
    const escapedProfileUrl = escapeHtml(profileUrl.toString());
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#252a23">
        <p style="color:#8c806f;font-size:12px">anChat</p>
        <h1 style="font-size:22px">${title}</h1>
        <p>For <strong>${escapedProfileName}</strong></p>
        ${detail}
        <p style="margin-top:24px"><a href="${escapedProfileUrl}" style="display:inline-block;padding:12px 18px;border-radius:6px;background:#252a23;color:#fff;text-decoration:none">Open profile</a></p>
      </div>`;
    const text = isNewQuestion
      ? `${title}\n\n${questionResult.data.body}\n\nOpen profile: ${profileUrl}`
      : `${title}\n\nYour question:\n${questionResult.data.body}\n\nReply:\n${answerBody}\n\nOpen profile: ${profileUrl}`;

    let emailResponse: Response;
    try {
      emailResponse = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ from: emailFrom, to: [email], subject, html, text }),
      });
    } catch (error) {
      console.error("Resend request failed", error);
      failedIds.push(notification.id);
      continue;
    }
    if (!emailResponse.ok) {
      console.error("Resend rejected notification email", emailResponse.status);
      failedIds.push(notification.id);
      continue;
    }

    const { error: updateError } = await admin
      .from("notifications")
      .update({
        email_status: "sent",
        email_started_at: null,
        email_sent_at: new Date().toISOString(),
      })
      .eq("id", notification.id);
    if (updateError) {
      console.error("Could not mark notification email as sent", updateError.message);
      return response({ error: "Could not update notification status" }, 500);
    }
    sent += 1;
  }

  if (failedIds.length) {
    const { error } = await admin
      .from("notifications")
      .update({ email_status: "failed", email_started_at: null })
      .in("id", failedIds);
    if (error) {
      console.error("Could not mark notification emails as failed", error.message);
      return response({ error: "Could not update notification status" }, 500);
    }
  }

  return failedIds.length
    ? response({ sent, error: "Some notification emails could not be sent" }, 502)
    : response({ sent });
});
