import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null | undefined;

/**
 * 可选云端适配器。未提供公开 URL 与匿名 key 时返回 null，
 * 本机进程管理、日志和 WebSocket 功能不依赖 Supabase。
 */
export function getOptionalSupabaseClient(): SupabaseClient | null {
  if (client !== undefined) return client;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonymousKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  client = url && anonymousKey
    ? createClient(url, anonymousKey, {
        auth: {
          persistSession: true,
          autoRefreshToken: true,
        },
      })
    : null;
  return client;
}

export function isSupabaseConfigured(): boolean {
  return Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
}
