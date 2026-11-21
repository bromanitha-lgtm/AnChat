import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

export const publicSupabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: {
        storageKey: "anchat-public-profile-reader",
        persistSession: false,
        autoRefreshToken: false,
        detectSessionInUrl: false,
      },
    })
  : null;

export type Profile = {
  id: string;
  handle: string;
  display_name: string;
  public_id: string;
};

export type Question = {
  id: string;
  target_profile_id?: string | null;
  asker_profile_id?: string | null;
  body: string;
  created_at: string;
  asker?: Pick<Profile, "handle" | "display_name"> | null;
  can_manage_question?: boolean;
  can_delete_question?: boolean;
  answer?: {
    body: string;
    created_at: string;
    updated_at: string;
  } | null;
};
