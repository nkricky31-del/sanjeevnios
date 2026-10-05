variable "account_id" {
  description = "Cloudflare account id (dashboard > any zone > right sidebar)."
  type        = string
}

variable "zone_id" {
  description = "Zone id of sanjeevnios.in (add the site to Cloudflare first and switch the registrar's nameservers)."
  type        = string
}

variable "domain" {
  type    = string
  default = "sanjeevnios.in"
}

variable "admin_emails" {
  description = "Emails allowed through Cloudflare Access to /admin* (one-time PIN to the inbox)."
  type        = list(string)
}

variable "vercel_apex_ip" {
  description = "Vercel's apex A record. Confirm in Vercel > Domains; 76.76.21.21 is Vercel's documented value."
  type        = string
  default     = "76.76.21.21"
}
