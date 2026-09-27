// ==========================================
// LINKZYFY SUPABASE CONFIG
// ==========================================
//
// This file initializes the shared Supabase client used
// across the application.
//
// The Supabase SDK (supabase-js) is loaded via CDN in the HTML
// files before this script runs.

const SUPABASE_URL = "https://grqeacirsyyzqbycvssn.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdycWVhY2lyc3l5enFieWN2c3NuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTAzMzQ0NzksImV4cCI6MjEwNTkxMDQ3OX0.C-9HuVhFpWvs8B307mkf-Flt2cfrZiSUihd4pYbTsV8";

// Create a single supabase client for interacting with your database
window.supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
