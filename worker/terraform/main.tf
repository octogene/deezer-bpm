locals {
  worker_dir     = abspath("${path.module}/..")
  migrations_dir = "${local.worker_dir}/migrations"
  # Absolute, because the migration provisioner runs from worker_dir: a
  # module-relative path would be resolved against the wrong directory.
  wrangler_config = abspath("${path.module}/.terraform/wrangler.toml")

  # Omitted on the bootstrap apply, which is the one that creates the class.
  # Cloudflare rejects a version that binds a Durable Object whose migration
  # that same version carries, because migrations run at deploy time.
  safety_budget_binding = var.bootstrap_durable_object ? [] : [
    {
      name       = "SAFETY_BUDGET"
      type       = "durable_object_namespace"
      class_name = "SafetyBudget"
    }
  ]
  migration_files = sort([
    for file in fileset(local.migrations_dir, "*.sql") : file
  ])
  migrations_hash = sha256(join("", [
    for file in local.migration_files : filesha256("${local.migrations_dir}/${file}")
  ]))
}

resource "cloudflare_d1_database" "sync" {
  account_id            = var.cloudflare_account_id
  name                  = var.database_name
  primary_location_hint = var.d1_location

  # Must be set explicitly: left unset, the provider sends
  # `read_replication: null` on update and the API rejects it. Replicas would
  # also spread reads across regions, which the daily read-row budget the Worker
  # enforces assumes it can account for in one place.
  read_replication = {
    mode = "disabled"
  }
}

# Wrangler records applied migrations in D1, making repeated Terraform applies
# safe while keeping schema changes ordered with the infrastructure deployment.
resource "local_sensitive_file" "wrangler" {
  filename = local.wrangler_config
  content  = <<-TOML
    name = "${var.worker_name}"
    compatibility_date = "2024-11-01"

    [[d1_databases]]
    binding = "DB"
    database_name = "${cloudflare_d1_database.sync.name}"
    database_id = "${cloudflare_d1_database.sync.id}"
    migrations_dir = "${local.migrations_dir}"
  TOML
}

resource "terraform_data" "d1_migrations" {
  triggers_replace = [
    cloudflare_d1_database.sync.id,
    local.migrations_hash,
  ]

  provisioner "local-exec" {
    command     = "npx --yes wrangler@4 d1 migrations apply DB --remote --config \"${local_sensitive_file.wrangler.filename}\""
    working_dir = local.worker_dir
  }
}

resource "cloudflare_worker" "sync" {
  account_id = var.cloudflare_account_id
  name       = var.worker_name

  observability = {
    enabled = true
  }

  subdomain = {
    enabled          = true
    previews_enabled = false
  }
}

resource "cloudflare_worker_version" "sync" {
  account_id         = var.cloudflare_account_id
  worker_id          = cloudflare_worker.sync.id
  compatibility_date = "2024-11-01"
  main_module        = "index.js"

  modules = [
    {
      name         = "index.js"
      content_type = "application/javascript+module"
      content_file = "${local.worker_dir}/build/index.js"
    },
    {
      name         = "index_bg.wasm"
      content_type = "application/wasm"
      content_file = "${local.worker_dir}/build/index_bg.wasm"
    },
  ]

  # Creates the SQLite-backed Durable Object class, and only on the bootstrap
  # apply. Cloudflare applies migrations when a version is *deployed*, so the
  # version that creates the class cannot also bind to it. See
  # local.safety_budget_binding.
  migrations = var.bootstrap_durable_object ? {
    new_sqlite_classes = ["SafetyBudget"]
  } : null

  bindings = concat([
    {
      name        = "DB"
      type        = "d1"
      database_id = cloudflare_d1_database.sync.id
    },
    {
      name         = "IP_RATE_LIMITER"
      type         = "ratelimit"
      namespace_id = var.rate_limit_namespace_id
      simple = {
        limit  = var.rate_limit_requests
        period = var.rate_limit_period
      }
    },
    {
      name         = "CODE_RATE_LIMITER"
      type         = "ratelimit"
      namespace_id = var.code_rate_limit_namespace_id
      simple = {
        limit  = var.code_rate_limit_requests
        period = var.rate_limit_period
      }
    },
    {
      name         = "CREATE_RATE_LIMITER"
      type         = "ratelimit"
      namespace_id = var.create_rate_limit_namespace_id
      simple = {
        limit  = var.create_rate_limit_requests
        period = 60
      }
    },
    {
      name         = "GLOBAL_RATE_LIMITER"
      type         = "ratelimit"
      namespace_id = var.global_rate_limit_namespace_id
      simple = {
        limit  = var.global_rate_limit_requests
        period = 60
      }
    },
    {
      name = "MAX_CHANGES"
      type = "plain_text"
      text = tostring(var.max_changes)
    },
    {
      name = "MAX_DELTA_ROWS"
      type = "plain_text"
      text = tostring(var.max_delta_rows)
    },
    {
      name = "MAX_TRACKS_PER_SPACE"
      type = "plain_text"
      text = tostring(var.max_tracks_per_space)
    },
    {
      name = "MAX_TRACK_ID_LENGTH"
      type = "plain_text"
      text = tostring(var.max_track_id_length)
    },
    {
      name = "DAILY_REQUEST_BUDGET"
      type = "plain_text"
      text = tostring(var.daily_request_budget)
    },
    {
      name = "DAILY_CREATION_BUDGET"
      type = "plain_text"
      text = tostring(var.daily_creation_budget)
    },
    {
      name = "DAILY_READ_ROW_BUDGET"
      type = "plain_text"
      text = tostring(var.daily_read_row_budget)
    },
    {
      name = "DAILY_WRITE_ROW_BUDGET"
      type = "plain_text"
      text = tostring(var.daily_write_row_budget)
    },
    {
      name = "EMPTY_SPACE_RETENTION_DAYS"
      type = "plain_text"
      text = tostring(var.empty_space_retention_days)
    },
    {
      name = "INACTIVE_SPACE_RETENTION_DAYS"
      type = "plain_text"
      text = tostring(var.inactive_space_retention_days)
    },
    {
      name = "CLEANUP_BATCH_SIZE"
      type = "plain_text"
      text = tostring(var.cleanup_batch_size)
    },
    {
      name = "TURNSTILE_SITE_KEY"
      type = "plain_text"
      text = var.turnstile_site_key
    },
    {
      name = "TURNSTILE_SECRET_KEY"
      type = "secret_text"
      text = var.turnstile_secret_key
    },
  ], local.safety_budget_binding)

  depends_on = [terraform_data.d1_migrations]
}

resource "cloudflare_workers_deployment" "sync" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.sync.name
  strategy    = "percentage"

  versions = [
    {
      version_id = cloudflare_worker_version.sync.id
      percentage = 100
    },
  ]

  annotations = {
    workers_message = "Managed by Terraform"
  }
}

resource "cloudflare_workers_cron_trigger" "cleanup" {
  account_id  = var.cloudflare_account_id
  script_name = cloudflare_worker.sync.name

  schedules = [
    {
      cron = "17 3 * * *"
    },
  ]

  depends_on = [cloudflare_workers_deployment.sync]
}
