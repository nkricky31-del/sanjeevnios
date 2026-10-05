terraform {
  required_version = ">= 1.5"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4.52"   # v4 resource names; v5 renamed several
    }
  }
}

provider "cloudflare" {
  # Reads CLOUDFLARE_API_TOKEN from the environment. Token permissions:
  #   Zone: Zone Settings:Edit, DNS:Edit, Zone WAF:Edit, Zone:Read
  #   Account: Turnstile:Edit, Access: Apps and Policies:Edit
}
