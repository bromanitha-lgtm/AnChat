export function getTrustedClientIp(request: Request): string | null {
  const cloudflareIp = request.headers.get("cf-connecting-ip")?.trim();
  if (cloudflareIp) return cloudflareIp;

  const forwardedIps = request.headers
    .get("x-forwarded-for")
    ?.split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);
  return forwardedIps?.at(-1) ?? null;
}
