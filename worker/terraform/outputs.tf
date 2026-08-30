output "d1_database_id" {
  description = "ID of the D1 sync database."
  value       = cloudflare_d1_database.sync.id
}

output "worker_name" {
  description = "Name used for the workers.dev endpoint."
  value       = cloudflare_worker.sync.name
}

output "version_urls" {
  description = "Cloudflare URLs that point directly to the deployed version."
  value       = cloudflare_worker_version.sync.urls
}
