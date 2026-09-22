terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = ">= 5.16, < 5.20.0"
    }
    local = {
      source  = "hashicorp/local"
      version = "~> 2.0"
    }
  }
}

# Stand in for the production build provisioner: this file exists only at apply.
resource "local_file" "bundle" {
  filename = "${path.module}/generated-bundle.js"
  content  = "export default { fetch() { return new Response('built'); } };"
}

module "worker" {
  source = "../../.."

  account_id       = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  worker_name      = "deferred-bundle-regression"
  worker_subdomain = "test"
  script_path      = local_file.bundle.filename

  depends_on = [local_file.bundle]
}
