-- PioDev: Admin RBAC Migration
-- Jalankan di Supabase Dashboard → SQL Editor

-- 1. Buat tabel profiles
CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Aktifkan RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 3. Policy: user hanya bisa lihat profil sendiri
DROP POLICY IF EXISTS "Users can view own profile" ON public.profiles;
CREATE POLICY "Users can view own profile" ON public.profiles
  FOR SELECT USING (auth.uid() = id);

-- 4. Policy: user bisa update profil sendiri (tapi tidak bisa ubah role)
DROP POLICY IF EXISTS "Users can update own non-role fields" ON public.profiles;
CREATE POLICY "Users can update own non-role fields" ON public.profiles
  FOR UPDATE USING (auth.uid() = id);

-- 5. Isi data user yang sudah ada
INSERT INTO public.profiles (id, full_name, role)
SELECT
  id,
  COALESCE(raw_user_meta_data->>'full_name', email),
  'user'
FROM auth.users
ON CONFLICT (id) DO NOTHING;

-- 6. Trigger: otomatis buat profile saat user baru daftar
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, role)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.email),
    'user'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- 7. (Opsional) Jadikan diri kamu admin — ganti email-nya
-- UPDATE public.profiles SET role = 'admin'
-- WHERE id = (SELECT id FROM auth.users WHERE email = 'emailkamu@contoh.com');

-- ── Tabel Changelog (What's New) ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.changelogs (
  id          SERIAL PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT NOT NULL,
  tag         TEXT NOT NULL DEFAULT 'new'
                CHECK (tag IN ('new', 'improvement', 'fix', 'removed')),
  published   BOOLEAN NOT NULL DEFAULT true,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- RLS tidak diperlukan karena diakses melalui service role key dari server

-- ── Kolom whats_new_last_seen di profiles ────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS whats_new_last_seen TIMESTAMPTZ DEFAULT NULL;

-- ── Tabel Video Jobs (Pio Studio) ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.video_jobs (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_id     TEXT NOT NULL DEFAULT '',
  prompt      TEXT NOT NULL,
  model       TEXT NOT NULL,
  mode        TEXT NOT NULL DEFAULT 'text-to-video' CHECK (mode IN ('text-to-video', 'image-to-video')),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  video_url   TEXT,
  image_url   TEXT,
  error       TEXT,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.video_jobs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own video jobs" ON public.video_jobs;
CREATE POLICY "Users can view own video jobs" ON public.video_jobs
  FOR SELECT USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can insert own video jobs" ON public.video_jobs;
CREATE POLICY "Users can insert own video jobs" ON public.video_jobs
  FOR INSERT WITH CHECK (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can update own video jobs" ON public.video_jobs;
CREATE POLICY "Users can update own video jobs" ON public.video_jobs
  FOR UPDATE USING (auth.uid() = user_id);

DROP POLICY IF EXISTS "Users can delete own video jobs" ON public.video_jobs;
CREATE POLICY "Users can delete own video jobs" ON public.video_jobs
  FOR DELETE USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_video_jobs_user_id ON public.video_jobs(user_id);
CREATE INDEX IF NOT EXISTS idx_video_jobs_status ON public.video_jobs(status);

-- ── Credit System (Pio Studio) ───────────────────────────────────────────────
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS video_credits INT NOT NULL DEFAULT 2;
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS video_credits_reset_date TEXT DEFAULT '';

-- Set semua user yang sudah ada agar punya 2 kredit
UPDATE public.profiles SET video_credits = 2 WHERE video_credits IS NULL;
