variable "cloudflare_account_id" {
  description = "Cloudflare account ID that owns the Worker and D1 database."
  type        = string
}

variable "worker_name" {
  description = "Name of the Cloudflare Worker."
  type        = string
  default     = "deezer-bpm-sync"
}

variable "database_name" {
  description = "Name of the D1 database."
  type        = string
  default     = "deezer-bpm-sync"
}

variable "d1_location" {
  description = "Optional D1 primary location hint."
  type        = string
  default     = null

  validation {
    condition = var.d1_location == null || contains([
      "wnam",
      "enam",
      "weur",
      "eeur",
      "apac",
      "oc",
    ], var.d1_location)
    error_message = "d1_location must be null, wnam, enam, weur, eeur, apac, or oc."
  }
}

variable "rate_limit_namespace_id" {
  description = "Positive integer string for the per-IP rate limiter."
  type        = string
  default     = "1001"

  validation {
    condition     = can(regex("^[1-9][0-9]*$", var.rate_limit_namespace_id))
    error_message = "rate_limit_namespace_id must be a positive integer encoded as a string."
  }
}

variable "rate_limit_requests" {
  description = "Maximum requests allowed per client IP and Cloudflare location."
  type        = number
  default     = 20

  validation {
    condition     = var.rate_limit_requests > 0 && floor(var.rate_limit_requests) == var.rate_limit_requests
    error_message = "rate_limit_requests must be a positive integer."
  }
}

variable "rate_limit_period" {
  description = "Rate-limit period in seconds."
  type        = number
  default     = 60

  validation {
    condition     = contains([10, 60], var.rate_limit_period)
    error_message = "rate_limit_period must be 10 or 60 seconds."
  }
}

variable "code_rate_limit_namespace_id" {
  description = "Positive integer string for the per-code rate limiter."
  type        = string
  default     = "1002"
}

variable "code_rate_limit_requests" {
  description = "Maximum requests allowed per sync code and Cloudflare location."
  type        = number
  default     = 30
}

variable "create_rate_limit_namespace_id" {
  description = "Positive integer string for the space-creation rate limiter."
  type        = string
  default     = "1003"
}

variable "create_rate_limit_requests" {
  description = "Maximum space creations allowed per IP and Cloudflare location."
  type        = number
  default     = 5
}

variable "global_rate_limit_namespace_id" {
  description = "Positive integer string for the endpoint-wide rate limiter."
  type        = string
  default     = "1004"
}

variable "global_rate_limit_requests" {
  description = "Maximum endpoint requests per Cloudflare location."
  type        = number
  default     = 300
}

variable "max_changes" {
  description = "Maximum changes accepted in one sync request."
  type        = number
  default     = 500
}

variable "max_delta_rows" {
  description = "Maximum changes returned in one sync response."
  type        = number
  default     = 1000
}

variable "max_tracks_per_space" {
  description = "Maximum stored track rows in one sync space."
  type        = number
  default     = 5000
}

variable "max_track_id_length" {
  description = "Maximum decimal track ID length."
  type        = number
  default     = 20
}

variable "daily_request_budget" {
  description = "Strict admitted Worker requests per UTC day."
  type        = number
  default     = 10000
}

variable "daily_creation_budget" {
  description = "Strict sync-space creations per UTC day."
  type        = number
  default     = 100
}

variable "daily_read_row_budget" {
  description = "Conservative D1 rows reserved for reads per UTC day."
  type        = number
  default     = 4000000
}

variable "daily_write_row_budget" {
  description = "Conservative D1 rows reserved for writes per UTC day."
  type        = number
  default     = 40000
}

variable "empty_space_retention_days" {
  description = "Days before unused empty spaces expire."
  type        = number
  default     = 7
}

variable "inactive_space_retention_days" {
  description = "Days before inactive spaces expire."
  type        = number
  default     = 180
}

variable "cleanup_batch_size" {
  description = "Maximum spaces removed by one scheduled cleanup."
  type        = number
  default     = 100
}

variable "turnstile_site_key" {
  description = "Turnstile site key used by the activation page."
  type        = string
}

variable "turnstile_secret_key" {
  description = "Turnstile secret key used for server-side verification."
  type        = string
  sensitive   = true
}

variable "bootstrap_durable_object" {
  description = <<-EOT
    Run the apply that creates the SafetyBudget Durable Object class.

    Cloudflare applies Durable Object migrations when a version is deployed, so
    one version cannot both create a class and bind to it. Deploying a new
    environment therefore takes two applies:

      terraform apply -var bootstrap_durable_object=true   # creates the class
      terraform apply                                      # adds the binding

    Between them the Worker is deployed without SAFETY_BUDGET, so /sync and
    /spaces fail until the second apply. Leave false for every later apply.
  EOT
  type        = bool
  default     = false
}
