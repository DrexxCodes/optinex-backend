import type { SupabaseClient } from '@supabase/supabase-js';

// No generated schema types in this codebase (same as the Next.js apps) — rows are loosely typed.
export type Db = SupabaseClient;
export type Row = Record<string, any>;
