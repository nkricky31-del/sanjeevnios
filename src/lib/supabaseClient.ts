// This file opens the one connection to your Supabase backend that the rest of the app reuses.
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseAnonKey) {
  throw new Error(
    'Missing Supabase env vars. Copy .env.local.example to .env.local and fill in your project URL and anon key.'
  );
}

export const supabase = createClient(supabaseUrl, supabaseAnonKey);
