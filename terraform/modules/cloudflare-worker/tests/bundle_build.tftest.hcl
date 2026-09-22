# Keep the real Cloudflare plan modifiers: mocking the provider would hide the
# missing-file hashing regression. These plan-only runs never call its API.
provider "cloudflare" {
  api_token = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
}

run "plan_before_bundle_exists" {
  command = plan

  module {
    source = "./tests/fixtures/deferred-build"
  }

  assert {
    condition     = !fileexists(local_file.bundle.filename)
    error_message = "The regression must plan successfully with no bundle on disk."
  }
}

run "hash_prebuilt_bundle" {
  command = plan

  variables {
    account_id       = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    worker_name      = "bundle-regression"
    worker_subdomain = "test"
    script_path      = "tests/fixtures/worker.js"
  }

  assert {
    condition     = one(cloudflare_worker_version.this.modules).content_sha256 == filesha256(var.script_path)
    error_message = "The provider must hash the exact bundle read by the data source."
  }
}
