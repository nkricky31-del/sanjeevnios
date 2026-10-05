# ---------------------------------------------------------------------------
# Cloudflare edge for sanjeevnios.in (Free plan compatible)
#   DNS (proxied) -> TLS hardening -> managed WAF -> custom rules ->
#   rate limit -> bot fight -> Turnstile widget -> Access on /admin*
# ---------------------------------------------------------------------------

# --- DNS: orange-cloud (proxied) records pointing at Vercel ----------------
resource "cloudflare_record" "apex" {
  zone_id         = var.zone_id
  name            = "@"
  type            = "A"
  content         = var.vercel_apex_ip
  proxied         = true
  allow_overwrite = true
}

resource "cloudflare_record" "www" {
  zone_id         = var.zone_id
  name            = "www"
  type            = "CNAME"
  content         = "cname.vercel-dns.com"
  proxied         = true
  allow_overwrite = true
}

# --- TLS / transport hardening ----------------------------------------------
resource "cloudflare_zone_settings_override" "tls" {
  zone_id = var.zone_id
  settings {
    ssl                      = "strict"     # Cloudflare <-> Vercel is verified TLS
    always_use_https         = "on"
    min_tls_version          = "1.2"
    tls_1_3                  = "on"
    automatic_https_rewrites = "on"
    security_level           = "medium"
    browser_check            = "on"
    # Free-plan DDoS protection (L3/4/7) is always on; nothing to switch.
  }
}

# --- Managed WAF (Free Managed Ruleset: critical exploits, e.g. Log4j) ------
resource "cloudflare_ruleset" "waf_managed" {
  zone_id = var.zone_id
  name    = "managed waf"
  kind    = "zone"
  phase   = "http_request_firewall_managed"

  rules {
    action      = "execute"
    description = "Cloudflare Free Managed Ruleset"
    expression  = "true"
    enabled     = true
    action_parameters {
      id = "77454fe2d30c4220b5701f6fdfb893ba" # Cloudflare Free Managed Ruleset
    }
  }
}

# --- Custom WAF rules (Free plan allows 5) ----------------------------------
resource "cloudflare_ruleset" "waf_custom" {
  zone_id = var.zone_id
  name    = "custom waf"
  kind    = "zone"
  phase   = "http_request_firewall_custom"

  # 1. Probes for files/panels this app does not have.
  rules {
    action      = "block"
    description = "Block scanner probes"
    enabled     = true
    expression  = <<-EOT
      (http.request.uri.path contains "/.env") or
      (http.request.uri.path contains "/.git") or
      (http.request.uri.path contains "/wp-admin") or
      (http.request.uri.path contains "/wp-login") or
      (http.request.uri.path contains "/phpmyadmin") or
      (http.request.uri.path contains "/xmlrpc.php") or
      (http.request.uri.path contains "/vendor/phpunit") or
      (http.request.uri.path contains "/cgi-bin")
    EOT
  }

  # 2. The website is a static SPA: it never receives POST/PUT/DELETE.
  rules {
    action      = "block"
    description = "Static site accepts only GET/HEAD/OPTIONS"
    enabled     = true
    expression  = "not (http.request.method in {\"GET\" \"HEAD\" \"OPTIONS\"}) and not starts_with(http.request.uri.path, \"/cdn-cgi/\")"
  }

  # 3. Scripted clients and empty user agents get a challenge, not the page.
  rules {
    action      = "managed_challenge"
    description = "Challenge scripted clients"
    enabled     = true
    expression  = <<-EOT
      (http.user_agent eq "") or
      (lower(http.user_agent) contains "python-requests") or
      (lower(http.user_agent) contains "scrapy") or
      (lower(http.user_agent) contains "curl/") or
      (lower(http.user_agent) contains "wget") or
      (lower(http.user_agent) contains "go-http-client") or
      (lower(http.user_agent) contains "httpclient") or
      (lower(http.user_agent) contains "headlesschrome")
    EOT
  }

  # 4. Very long query strings are an injection/abuse smell on a static site.
  rules {
    action      = "block"
    description = "Oversized query string"
    enabled     = true
    expression  = "len(http.request.uri.query) > 1024"
  }
}

# --- Rate limiting at the edge (Free plan: 1 rule, 10s window) --------------
# Protects the website/CDN layer. API traffic (browser -> Supabase) is limited
# in the database - see supabase/migration_74_edge_rate_limiting.sql.
resource "cloudflare_ruleset" "rate_limit" {
  zone_id = var.zone_id
  name    = "rate limit"
  kind    = "zone"
  phase   = "http_ratelimit"

  rules {
    action      = "block"
    description = "Per-IP flood limit"
    enabled     = true
    expression  = "true"
    ratelimit {
      characteristics     = ["cf.colo.id", "ip.src"]
      period              = 10
      requests_per_period = 100
      mitigation_timeout  = 10
    }
  }
}

# --- Bot Fight Mode (Free) ---------------------------------------------------
resource "cloudflare_bot_management" "fight" {
  zone_id    = var.zone_id
  fight_mode = true
}

# --- Turnstile (the CAPTCHA) -------------------------------------------------
resource "cloudflare_turnstile_widget" "app" {
  account_id = var.account_id
  name       = "sanjeevnios"
  domains    = [var.domain, "www.${var.domain}"]
  mode       = "managed"
  region     = "world"
}

# --- Admin behind Cloudflare Access (Zero Trust, free <= 50 users) ----------
resource "cloudflare_access_application" "admin" {
  zone_id          = var.zone_id
  name             = "SanjeevniOS admin"
  domain           = "www.${var.domain}/admin"
  type             = "self_hosted"
  session_duration = "8h"
}

resource "cloudflare_access_policy" "admin_allow" {
  application_id = cloudflare_access_application.admin.id
  zone_id        = var.zone_id
  name           = "owners only"
  precedence     = 1
  decision       = "allow"

  include {
    email = var.admin_emails
  }
}
