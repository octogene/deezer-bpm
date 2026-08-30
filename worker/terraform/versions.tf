terraform {
  required_version = ">= 1.10.0"

  backend "s3" {
    key                         = "deezer-bpm-sync/terraform.tfstate"
    region                      = "auto"
    encrypt                     = true
    use_lockfile                = true
    use_path_style              = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.23"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.5"
    }
  }
}

provider "cloudflare" {}
