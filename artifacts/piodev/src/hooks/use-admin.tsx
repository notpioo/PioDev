import { useState, useCallback } from "react";
import { supabase } from "@/lib/supabase";

export type AdminUser = {
  id: string;
  email: string;
  full_name: string;
  role: "user" | "admin";
  created_at: string;
  last_sign_in_at: string | null;
};

export type AdminStats = {
  totalUsers: number;
  totalConversations: number;
  totalMessages: number;
  totalTokens: number;
};

export type DailyUsage = {
  date: string;
  token: number;
  pesan: number;
};

async function authHeader() {
  const { data: { session } } = await supabase.auth.getSession();
  return { Authorization: `Bearer ${session?.access_token ?? ""}` };
}

export function useAdmin() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [dailyUsage, setDailyUsage] = useState<DailyUsage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchUsers = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/users", { headers: await authHeader() });
      if (!res.ok) throw new Error((await res.json()).error || "Gagal memuat users");
      const data = await res.json();
      setUsers(data.users);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/stats", { headers: await authHeader() });
      if (!res.ok) return;
      const data = await res.json();
      setStats(data);
    } catch { /**/ }
  }, []);

  const updateRole = useCallback(async (userId: string, role: "user" | "admin") => {
    const res = await fetch(`/api/admin/users/${userId}/role`, {
      method: "PATCH",
      headers: { ...(await authHeader()), "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Gagal mengubah role");
    }
    setUsers((prev) =>
      prev.map((u) => (u.id === userId ? { ...u, role } : u))
    );
  }, []);

  const deleteUser = useCallback(async (userId: string) => {
    const res = await fetch(`/api/admin/users/${userId}`, {
      method: "DELETE",
      headers: await authHeader(),
    });
    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || "Gagal menghapus user");
    }
    setUsers((prev) => prev.filter((u) => u.id !== userId));
  }, []);

  const fetchDailyUsage = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/daily-usage", { headers: await authHeader() });
      if (!res.ok) return;
      const data = await res.json();
      setDailyUsage(data.daily || []);
    } catch { /**/ }
  }, []);

  return { users, stats, dailyUsage, isLoading, error, fetchUsers, fetchStats, fetchDailyUsage, updateRole, deleteUser };
}
