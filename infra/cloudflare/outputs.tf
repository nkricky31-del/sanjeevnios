output "turnstile_site_key" {
  description = "Public. Set as VITE_TURNSTILE_SITE_KEY in Vercel."
  value       = cloudflare_turnstile_widget.app.id
}

output "turnstile_secret_key" {
  description = "SECRET. Put in Supabase (Auth > Attack Protection) and `supabase secrets set TURNSTILE_SECRET_KEY`."
  value       = cloudflare_turnstile_widget.app.secret
  sensitive   = true
}
