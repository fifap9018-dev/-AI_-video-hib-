
// Cloudflare Pages Function — Runway text-to-video proxy.
// Secret key stays on the server (RUNWAYML_API_SECRET).
//   POST /api/video            { prompt, style, ratio, duration } -> { id }
//   GET  /api/video?id=TASK_ID                                    -> { status, videoUrl?, error? }

const API_ROOT = "https://api.dev.runwayml.com/v1";
const DEFAULT_VERSION = "2024-11-06";
const MODEL = "gen4.5";
const RATIOS = ["1280:720", "720:1280"];
const DURATIONS = [5, 10];
const STYLES = {
  cinematic: "cinematic composition, dramatic natural lighting, subtle film grain, controlled camera movement, atmospheric depth",
  realistic: "photorealistic, natural textures, true-to-life colors, physically accurate motion",
  anime: "premium hand-drawn anime aesthetic, expressive motion, detailed painted backgrounds",
  documentary: "observational documentary style, natural light, authentic textures, restrained camera movement"
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }
  });

const runwayHeaders = (env) => ({
  Authorization: `Bearer ${env.RUNWAYML_API_SECRET}`,
  "X-Runway-Version": env.RUNWAY_API_VERSION || DEFAULT_VERSION,
  "Content-Type": "application/json"
});

function providerError(status, data) {
  if (status === 401 || status === 403) return "مفتاح Runway غير صالح أو ما عندوش الصلاحية (راجع RUNWAYML_API_SECRET).";
  if (status === 402) return "الرصيد ديال Runway API سالا. زيد credits فـ dev.runwayml.com.";
  if (status === 429) return "الطلبات بزاف دابا. تسنى شوية وعاود.";
  const msg = typeof data?.error === "string" ? data.error.slice(0, 200) : "";
  return msg || `وقع خطأ عند Runway (${status}).`;
}

async function overLimit(request, env) {
  if (!env.RATE_KV) return false;
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const key = `rl:${ip}:${new Date().toISOString().slice(0, 10)}`;
  const used = Number(await env.RATE_KV.get(key)) || 0;
  if (used >= (Number(env.DAILY_LIMIT) || 3)) return true;
  await env.RATE_KV.put(key, String(used + 1), { expirationTtl: 90000 });
  return false;
}

export async function onRequestPost({ request, env }) {
  if (!env.RUNWAYML_API_SECRET) return json({ error: "مفتاح Runway غير مضبوط فالسيرفر (RUNWAYML_API_SECRET)." }, 503);

  let body;
  try { body = await request.json(); } catch { return json({ error: "الطلب ماشي JSON صالح." }, 400); }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (prompt.length < 8) return json({ error: "زيد شوية ديال التفاصيل فالبرومبت." }, 400);
  if (prompt.length > 800) return json({ error: "البرومبت طويل بزاف (الحد 800 حرف)." }, 413);
  const ratio = RATIOS.includes(body.ratio) ? body.ratio : "1280:720";
  const duration = DURATIONS.includes(Number(body.duration)) ? Number(body.duration) : 5;
  const suffix = STYLES[body.style] || STYLES.cinematic;

  if (await overLimit(request, env)) return json({ error: "وصلتي للحد اليومي ديال التوليد. عاود غدا." }, 429);

  try {
    const res = await fetch(`${API_ROOT}/text_to_video`, {
      method: "POST",
      headers: runwayHeaders(env),
      body: JSON.stringify({
        model: MODEL,
        promptText: `${prompt}. ${suffix}. No text, no subtitles, no logos.`.slice(0, 1000),
        ratio,
        duration
      })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json({ error: providerError(res.status, data) }, res.status === 429 ? 429 : 502);
    if (!data.id) return json({ error: "Runway ما رجّعش رقم المهمة. عاود." }, 502);
    return json({ id: data.id });
  } catch {
    return json({ error: "تعذر الاتصال بـ Runway. حاول من جديد." }, 502);
  }
}

export async function onRequestGet({ request, env }) {
  if (!env.RUNWAYML_API_SECRET) return json({ error: "مفتاح Runway غير مضبوط فالسيرفر." }, 503);
  const id = new URL(request.url).searchParams.get("id") || "";
  if (!/^[A-Za-z0-9_-]{8,64}$/.test(id)) return json({ error: "رقم المهمة غير صالح." }, 400);

  try {
    const res = await fetch(`${API_ROOT}/tasks/${id}`, { headers: runwayHeaders(env) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return json({ error: providerError(res.status, data) }, 502);

    if (data.status === "SUCCEEDED") {
      const videoUrl = Array.isArray(data.output) ? data.output[0] : "";
      return videoUrl ? json({ status: "SUCCEEDED", videoUrl }) : json({ error: "Runway ما رجّعش رابط الفيديو." }, 502);
    }
    if (data.status === "FAILED" || data.status === "CANCELLED") {
      return json({ status: data.status, error: (typeof data.failure === "string" && data.failure.slice(0, 200)) || "فشل التوليد. جرب برومبت آخر." });
    }
    return json({ status: data.status || "RUNNING" });
  } catch {
    return json({ error: "تعذر الاتصال بـ Runway. حاول من جديد." }, 502);
  }
    }
