import express from "express";
import { createClient } from "@supabase/supabase-js";
import net from "net";

const SERVER_PORT = Number(process.env.SERVER_PORT ?? 3099);
const DAILY_TOKEN_LIMIT = 60_000;
const DAILY_VIDEO_CREDITS = 2;

/** Tanggal hari ini dalam timezone WIB (UTC+7), format YYYY-MM-DD */
function getTodayWIB(): string {
  const wib = new Date(Date.now() + 7 * 60 * 60 * 1000);
  return wib.toISOString().slice(0, 10);
}

const supabaseUrl = process.env.VITE_SUPABASE_URL!;
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY!;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const dashscopeApiKey = process.env.VITE_OPENAI_API_KEY!;

if (!supabaseUrl || !supabaseAnonKey || !dashscopeApiKey) {
  console.error("[PioDev API] Missing required environment variables.");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseAnonKey);
const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

const app = express();
app.use(express.json());
app.use(express.raw({ type: (req: any) => !(req.headers?.["content-type"] || "").startsWith("application/json"), limit: "50mb" }));

async function requireAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const token = authHeader.slice(7);
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  (req as any).userId = user.id;
  next();
}

async function requireAdmin(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const userId = (req as any).userId;
  if (!userId) { res.status(401).json({ error: "Unauthorized" }); return; }

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .single();

  if (profile?.role !== "admin") {
    res.status(403).json({ error: "Forbidden: admin only" });
    return;
  }
  next();
}

// ── GET /api/me/role  (ambil role user sendiri) ──────────────────────────────
app.get("/api/me/role", requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const { data, error } = await supabaseAdmin
    .from("profiles")
    .select("role")
    .eq("id", userId)
    .single();

  if (error || !data) {
    res.json({ role: "user" });
    return;
  }
  res.json({ role: data.role });
});

// ── GET /api/admin/users  (daftar semua user) ─────────────────────────────────
app.get("/api/admin/users", requireAuth, requireAdmin, async (_req, res) => {
  const { data: authUsers, error: authErr } = await supabaseAdmin.auth.admin.listUsers();
  if (authErr) { res.status(500).json({ error: authErr.message }); return; }

  const { data: profiles } = await supabaseAdmin.from("profiles").select("*");
  const profileMap: Record<string, any> = {};
  (profiles || []).forEach((p: any) => { profileMap[p.id] = p; });

  const users = authUsers.users.map((u) => ({
    id: u.id,
    email: u.email,
    full_name: profileMap[u.id]?.full_name || u.user_metadata?.full_name || "",
    role: profileMap[u.id]?.role || "user",
    created_at: u.created_at,
    last_sign_in_at: u.last_sign_in_at,
  }));

  res.json({ users });
});

// ── GET /api/admin/stats  (statistik singkat) ─────────────────────────────────
app.get("/api/admin/stats", requireAuth, requireAdmin, async (_req, res) => {
  const { data: authUsers } = await supabaseAdmin.auth.admin.listUsers();
  const totalUsers = authUsers?.users.length ?? 0;

  const { count: totalConversations } = await supabaseAdmin
    .from("conversations")
    .select("*", { count: "exact", head: true });

  const { count: totalMessages } = await supabaseAdmin
    .from("messages")
    .select("*", { count: "exact", head: true });

  const { data: tokenData } = await supabaseAdmin
    .from("daily_token_usage")
    .select("total_tokens");

  const totalTokens = (tokenData || []).reduce(
    (sum: number, row: any) => sum + (row.total_tokens || 0), 0
  );

  res.json({ totalUsers, totalConversations, totalMessages, totalTokens });
});

// ── PATCH /api/admin/users/:id/role  (ubah role user) ────────────────────────
app.patch("/api/admin/users/:id/role", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  let body: any = {};
  try {
    const raw = req.body instanceof Buffer ? req.body.toString("utf8") : req.body;
    body = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch { /**/ }

  const { role } = body;
  if (!["user", "admin"].includes(role)) {
    res.status(400).json({ error: "Role harus 'user' atau 'admin'" });
    return;
  }

  const { error } = await supabaseAdmin
    .from("profiles")
    .upsert({ id, role }, { onConflict: "id" });

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

// ── DELETE /api/admin/users/:id  (hapus user) ─────────────────────────────────
app.delete("/api/admin/users/:id", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { error } = await supabaseAdmin.auth.admin.deleteUser(id);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ success: true });
});

// ── GET /api/admin/users/:id/usage  (token usage per user) ────────────────────
app.get("/api/admin/users/:id/usage", requireAuth, requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { data, error } = await supabaseAdmin
    .from("daily_token_usage")
    .select("*")
    .eq("user_id", id)
    .order("date", { ascending: false })
    .limit(30);

  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ usage: data || [] });
});

// ── GET /api/admin/daily-usage  (grafik token 7 hari) ─────────────────────────
app.get("/api/admin/daily-usage", async (_req, res, next) => {
  console.log("[daily-usage] INCOMING REQUEST — auth:", _req.headers.authorization?.slice(0,20));
  next();
}, requireAuth, requireAdmin, async (_req, res) => {
  // Ambil semua data tanpa filter tanggal di query (hindari masalah tipe kolom)
  const { data, error } = await supabaseAdmin
    .from("daily_token_usage")
    .select("date, total_tokens, messages")
    .order("date", { ascending: true });

  console.log("[daily-usage] rows:", data?.length ?? 0, "error:", error?.message ?? null);
  if (data && data.length > 0) console.log("[daily-usage] sample row:", JSON.stringify(data[0]));

  if (error) { res.status(500).json({ error: error.message }); return; }

  // Hitung batas 7 hari terakhir di JS
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  cutoff.setHours(0, 0, 0, 0);

  const byDate: Record<string, { total_tokens: number; messages: number }> = {};

  (data || []).forEach((row: any) => {
    // date bisa berupa "2026-03-26" atau timestamp ISO
    const rawDate = String(row.date || "").slice(0, 10); // ambil YYYY-MM-DD saja
    if (!rawDate || rawDate.length < 10) return;
    const rowDate = new Date(rawDate + "T00:00:00");
    if (rowDate < cutoff) return; // lewati data lebih lama dari 7 hari
    if (!byDate[rawDate]) byDate[rawDate] = { total_tokens: 0, messages: 0 };
    byDate[rawDate].total_tokens += Number(row.total_tokens) || 0;
    byDate[rawDate].messages += Number(row.messages) || 0;
  });

  // Pastikan 7 slot hari selalu ada (isi 0 kalau tidak ada data) — berbasis WIB
  const slots: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(Date.now() + 7 * 60 * 60 * 1000 - i * 24 * 60 * 60 * 1000);
    slots.push(d.toISOString().slice(0, 10));
  }

  const daily = slots.map((dateStr) => {
    const vals = byDate[dateStr] ?? { total_tokens: 0, messages: 0 };
    return {
      date: new Date(dateStr + "T00:00:00").toLocaleDateString("id-ID", { day: "numeric", month: "short" }),
      token: vals.total_tokens,
      pesan: vals.messages,
    };
  });

  res.json({ daily });
});

// ── Changelog (What's New) ─────────────────────────────────────────────────────
app.get("/api/changelog", async (_req, res) => {
  const { data, error } = await supabaseAdmin
    .from("changelogs")
    .select("*")
    .eq("published", true)
    .order("created_at", { ascending: false });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data ?? []);
});

app.post("/api/admin/changelog", requireAuth, requireAdmin, async (req, res) => {
  const { title, description, tag } = req.body as { title?: string; description?: string; tag?: string };
  if (!title?.trim() || !description?.trim()) {
    res.status(400).json({ error: "title dan description wajib diisi." }); return;
  }
  const validTags = ["new", "improvement", "fix", "removed"];
  const { data, error } = await supabaseAdmin
    .from("changelogs")
    .insert({ title: title.trim(), description: description.trim(), tag: validTags.includes(tag ?? "") ? tag : "new" })
    .select()
    .single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

app.delete("/api/admin/changelog/:id", requireAuth, requireAdmin, async (req, res) => {
  const { error } = await supabaseAdmin
    .from("changelogs")
    .delete()
    .eq("id", Number(req.params.id));
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
});

// ── GET /api/me/quota  (sisa token hari ini) ───────────────────────────────────
app.get("/api/me/quota", requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const today = getTodayWIB();
  const { data } = await supabaseAdmin
    .from("daily_token_usage")
    .select("total_tokens")
    .eq("user_id", userId)
    .eq("date", today)
    .single();
  const used = data?.total_tokens ?? 0;
  res.json({ used, limit: DAILY_TOKEN_LIMIT, remaining: Math.max(0, DAILY_TOKEN_LIMIT - used) });
});

app.get("/api/me/whats-new-last-seen", requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const { data } = await supabaseAdmin
    .from("profiles")
    .select("whats_new_last_seen")
    .eq("id", userId)
    .single();
  res.json({ lastSeen: data?.whats_new_last_seen ?? null });
});

app.put("/api/me/whats-new-last-seen", requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const now = new Date().toISOString();
  await supabaseAdmin
    .from("profiles")
    .update({ whats_new_last_seen: now })
    .eq("id", userId);
  res.json({ lastSeen: now });
});

// ── Video Credits API ──────────────────────────────────────────────────────────
async function getVideoCredits(userId: string): Promise<{ credits: number; maxCredits: number }> {
  const today = getTodayWIB();
  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("video_credits, video_credits_reset_date, role")
    .eq("id", userId)
    .single();

  if (!profile) return { credits: 0, maxCredits: DAILY_VIDEO_CREDITS };

  if (profile.role === "admin") return { credits: 999, maxCredits: 999 };

  if (profile.video_credits_reset_date !== today) {
    await supabaseAdmin
      .from("profiles")
      .update({ video_credits: DAILY_VIDEO_CREDITS, video_credits_reset_date: today })
      .eq("id", userId);
    return { credits: DAILY_VIDEO_CREDITS, maxCredits: DAILY_VIDEO_CREDITS };
  }

  return { credits: profile.video_credits ?? 0, maxCredits: DAILY_VIDEO_CREDITS };
}

async function deductVideoCredit(userId: string): Promise<boolean> {
  const today = getTodayWIB();

  const { data: profile } = await supabaseAdmin
    .from("profiles")
    .select("role, video_credits, video_credits_reset_date")
    .eq("id", userId)
    .single();

  if (!profile) return false;
  if (profile.role === "admin") return true;

  if (profile.video_credits_reset_date !== today) {
    await supabaseAdmin
      .from("profiles")
      .update({ video_credits: DAILY_VIDEO_CREDITS - 1, video_credits_reset_date: today })
      .eq("id", userId);
    return true;
  }

  if ((profile.video_credits ?? 0) <= 0) return false;

  const newCredits = (profile.video_credits ?? 1) - 1;
  const { error } = await supabaseAdmin
    .from("profiles")
    .update({ video_credits: newCredits })
    .eq("id", userId)
    .eq("video_credits", profile.video_credits);

  if (error) return false;
  return true;
}

app.get("/api/video-credits", requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const result = await getVideoCredits(userId);
  res.json(result);
});

app.post("/api/video-credits/deduct", requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const ok = await deductVideoCredit(userId);
  if (!ok) {
    res.status(429).json({ error: "Kredit video habis untuk hari ini. Coba lagi besok!" });
    return;
  }
  const result = await getVideoCredits(userId);
  res.json(result);
});

// ── Video Jobs API (Pio Studio) ────────────────────────────────────────────────
app.get("/api/video-jobs", requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const { data, error } = await supabaseAdmin
    .from("video_jobs")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false });
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data || []);
});

app.post("/api/video-jobs", requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const { task_id, prompt, model, mode, status, image_url } = req.body;
  const { data, error } = await supabaseAdmin
    .from("video_jobs")
    .insert({ user_id: userId, task_id, prompt, model, mode, status: status || "pending", image_url })
    .select()
    .single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

app.patch("/api/video-jobs/:id", requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const { id } = req.params;
  const updates: Record<string, any> = {};
  if (req.body.status !== undefined) updates.status = req.body.status;
  if (req.body.video_url !== undefined) updates.video_url = req.body.video_url;
  if (req.body.error !== undefined) updates.error = req.body.error;
  const { data, error } = await supabaseAdmin
    .from("video_jobs")
    .update(updates)
    .eq("id", id)
    .eq("user_id", userId)
    .select()
    .single();
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json(data);
});

app.delete("/api/video-jobs/:id", requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const { id } = req.params;
  const { error } = await supabaseAdmin.from("video_jobs").delete().eq("id", id).eq("user_id", userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
});

app.delete("/api/video-jobs", requireAuth, async (req, res) => {
  const userId = (req as any).userId;
  const { error } = await supabaseAdmin.from("video_jobs").delete().eq("user_id", userId);
  if (error) { res.status(500).json({ error: error.message }); return; }
  res.json({ ok: true });
});

// ── DashScope proxy ────────────────────────────────────────────────────────────
app.all("/api/dashscope/*splat", requireAuth, async (req, res) => {
  // Cek quota harian sebelum forward ke DashScope
  const userId = (req as any).userId;
  const today = getTodayWIB();
  const { data: usageRow } = await supabaseAdmin
    .from("daily_token_usage")
    .select("total_tokens")
    .eq("user_id", userId)
    .eq("date", today)
    .single();
  const todayTokens = usageRow?.total_tokens ?? 0;
  if (todayTokens >= DAILY_TOKEN_LIMIT) {
    res.status(429)
      .set("X-Pioo-Error", "QUOTA_EXCEEDED")
      .json({ error: `Limit harian ${DAILY_TOKEN_LIMIT.toLocaleString()} token sudah tercapai. Coba lagi besok ya!` });
    return;
  }
  const dashscopePath = req.path.replace("/api/dashscope", "");
  const queryString = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  const targetUrl = `https://dashscope-intl.aliyuncs.com${dashscopePath}${queryString}`;

  const forwardHeaders: Record<string, string> = {
    Authorization: `Bearer ${dashscopeApiKey}`,
  };
  const ct = req.headers["content-type"];
  if (ct) forwardHeaders["Content-Type"] = ct as string;
  for (const [key, val] of Object.entries(req.headers)) {
    if (key.toLowerCase().startsWith("x-dashscope-") && typeof val === "string") {
      forwardHeaders[key] = val;
    }
  }

  const fetchInit: RequestInit = {
    method: req.method,
    headers: forwardHeaders,
  };

  if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
    if (req.body instanceof Buffer) {
      if (req.body.length > 0) fetchInit.body = req.body;
    } else if (typeof req.body === "object") {
      fetchInit.body = JSON.stringify(req.body);
    }
  }

  let upstream: Response;
  try {
    upstream = await fetch(targetUrl, fetchInit);
  } catch (err) {
    console.error("[PioDev API] Upstream fetch error:", err);
    res.status(502).json({ error: "Bad gateway" });
    return;
  }

  res.status(upstream.status);
  upstream.headers.forEach((value, key) => {
    const skip = ["transfer-encoding", "connection", "keep-alive", "content-encoding", "content-length"];
    if (!skip.includes(key.toLowerCase())) res.setHeader(key, value);
  });

  if (!upstream.body) { res.end(); return; }

  const reader = upstream.body.getReader();
  const pump = async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) { res.end(); break; }
        res.write(Buffer.from(value));
      }
    } catch { res.end(); }
  };
  pump();
});

// Cek apakah port sudah dipakai sebelum mencoba bind
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createConnection({ port, host: "127.0.0.1" });
    tester.once("connect", () => { tester.destroy(); resolve(true); });
    tester.once("error", () => resolve(false));
    tester.setTimeout(200, () => { tester.destroy(); resolve(false); });
  });
}

const portTaken = await isPortInUse(SERVER_PORT);
if (portTaken) {
  console.log(`[PioDev API] Port ${SERVER_PORT} sudah dipakai instance lain. Skip start server.`);
  // Jaga event loop tetap hidup agar Vite di concurrently tidak mati
  setInterval(() => {}, 60_000);
} else {
  const server = app.listen(SERVER_PORT, "0.0.0.0", () => {
    console.log(`[PioDev API] Secure proxy running on port ${SERVER_PORT}`);
  });

  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error("[PioDev API] Server error:", err.code, err.message);
    // Jika port tetiba ditangkap instance lain, tetap jaga proses
    setInterval(() => {}, 60_000);
  });

  process.on("uncaughtException", (err) => {
    console.error("[PioDev API] Uncaught exception:", err);
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[PioDev API] Unhandled rejection:", reason);
  });
}
