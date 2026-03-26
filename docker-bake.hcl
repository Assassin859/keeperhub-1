# Docker Buildx Bake definition for parallel image builds.
# Used by deploy-keeperhub.yaml via docker/bake-action to build the "app" and
# "migrator" targets from our Dockerfile concurrently in a single BuildKit
# session. Shared Dockerfile stages (deps, source) are built once and reused
# across both targets, saving ~47s vs sequential build-push-action steps.
# Variables are passed as env vars from the GHA workflow.
# Docs: https://docs.docker.com/build/bake/reference/

variable "ECR_REGISTRY" { default = "" }
variable "ECR_REPO" { default = "" }
variable "IMAGE_TAG" { default = "latest" }
variable "NEXT_PUBLIC_AUTH_PROVIDERS" { default = "" }
variable "NEXT_PUBLIC_GITHUB_CLIENT_ID" { default = "" }
variable "NEXT_PUBLIC_GOOGLE_CLIENT_ID" { default = "" }
variable "NEXT_PUBLIC_BILLING_ENABLED" { default = "" }
variable "ENVIRONMENT_TAG" { default = "" }
variable "NEXT_PUBLIC_SENTRY_DSN" { default = "" }
variable "SENTRY_ORG" { default = "" }
variable "SENTRY_PROJECT" { default = "" }
variable "SENTRY_AUTH_TOKEN" { default = "" }
variable "SENTRY_RELEASE" { default = "" }
variable "EVENTS_ECR_TRACKER_REPO" { default = "" }
variable "SCHEDULER_ECR_REPO" { default = "" }
variable "EXECUTOR_ECR_REPO" { default = "" }

group "default" {
  targets = ["app", "migrator", "workflow-runner"]
}

group "events" {
  targets = ["event-tracker"]
}

group "scheduler" {
  targets = ["schedule-dispatcher", "block-dispatcher"]
}

group "all" {
  targets = ["app", "migrator", "workflow-runner", "event-tracker", "schedule-dispatcher", "block-dispatcher", "executor"]
}

target "app" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "runner"
  args = {
    NEXT_PUBLIC_AUTH_PROVIDERS    = NEXT_PUBLIC_AUTH_PROVIDERS
    NEXT_PUBLIC_GITHUB_CLIENT_ID = NEXT_PUBLIC_GITHUB_CLIENT_ID
    NEXT_PUBLIC_GOOGLE_CLIENT_ID = NEXT_PUBLIC_GOOGLE_CLIENT_ID
    NEXT_PUBLIC_BILLING_ENABLED  = NEXT_PUBLIC_BILLING_ENABLED
    NEXT_PUBLIC_SENTRY_DSN       = NEXT_PUBLIC_SENTRY_DSN
    SENTRY_ORG                   = SENTRY_ORG
    SENTRY_PROJECT               = SENTRY_PROJECT
    SENTRY_AUTH_TOKEN            = SENTRY_AUTH_TOKEN
    SENTRY_RELEASE               = SENTRY_RELEASE
  }
  tags = compact([
    "${ECR_REGISTRY}/${ECR_REPO}:app-${IMAGE_TAG}",
    "${ECR_REGISTRY}/${ECR_REPO}:app-latest",
    ENVIRONMENT_TAG != "" ? "${ECR_REGISTRY}/${ECR_REPO}:${ENVIRONMENT_TAG}" : "",
  ])
  cache-from = ["type=registry,ref=${ECR_REGISTRY}/${ECR_REPO}:cache-app"]
  cache-to   = ["type=registry,ref=${ECR_REGISTRY}/${ECR_REPO}:cache-app,mode=max"]
}

target "migrator" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "migrator"
  tags = [
    "${ECR_REGISTRY}/${ECR_REPO}:migrator-${IMAGE_TAG}",
    "${ECR_REGISTRY}/${ECR_REPO}:migrator-latest",
  ]
  cache-from = [
    "type=registry,ref=${ECR_REGISTRY}/${ECR_REPO}:cache-app",
    "type=registry,ref=${ECR_REGISTRY}/${ECR_REPO}:cache-migrator",
  ]
  cache-to = ["type=registry,ref=${ECR_REGISTRY}/${ECR_REPO}:cache-migrator,mode=max"]
}

target "workflow-runner" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "workflow-runner"
  tags = compact([
    "${ECR_REGISTRY}/${ECR_REPO}:workflow-runner-${IMAGE_TAG}",
    "${ECR_REGISTRY}/${ECR_REPO}:workflow-runner-latest",
    ENVIRONMENT_TAG != "" ? "${ECR_REGISTRY}/${ECR_REPO}:workflow-runner-${ENVIRONMENT_TAG}" : "",
  ])
  cache-from = [
    "type=registry,ref=${ECR_REGISTRY}/${ECR_REPO}:cache-app",
    "type=registry,ref=${ECR_REGISTRY}/${ECR_REPO}:cache-workflow-runner",
  ]
  cache-to = ["type=registry,ref=${ECR_REGISTRY}/${ECR_REPO}:cache-workflow-runner,mode=max"]
  attest   = []
}

target "event-tracker" {
  context    = "./keeperhub-events"
  dockerfile = "event-tracker/Dockerfile"
  tags = compact([
    "${ECR_REGISTRY}/${EVENTS_ECR_TRACKER_REPO}:event-${IMAGE_TAG}",
    "${ECR_REGISTRY}/${EVENTS_ECR_TRACKER_REPO}:event-latest",
    ENVIRONMENT_TAG != "" ? "${ECR_REGISTRY}/${EVENTS_ECR_TRACKER_REPO}:${ENVIRONMENT_TAG}" : "",
  ])
  cache-from = ["type=registry,ref=${ECR_REGISTRY}/${EVENTS_ECR_TRACKER_REPO}:cache"]
  cache-to   = ["type=registry,ref=${ECR_REGISTRY}/${EVENTS_ECR_TRACKER_REPO}:cache,mode=max"]
  attest     = []
}

target "schedule-dispatcher" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "schedule-dispatcher"
  tags = compact([
    "${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:schedule-${IMAGE_TAG}",
    "${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:schedule-latest",
    ENVIRONMENT_TAG != "" ? "${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:schedule-${ENVIRONMENT_TAG}" : "",
  ])
  cache-from = [
    "type=registry,ref=${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:cache-deps",
    "type=registry,ref=${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:cache-dispatcher",
  ]
  cache-to = ["type=registry,ref=${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:cache-dispatcher,mode=max"]
  attest   = []
}

target "block-dispatcher" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "block-dispatcher"
  tags = compact([
    "${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:block-${IMAGE_TAG}",
    "${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:block-latest",
    ENVIRONMENT_TAG != "" ? "${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:block-${ENVIRONMENT_TAG}" : "",
  ])
  cache-from = [
    "type=registry,ref=${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:cache-deps",
    "type=registry,ref=${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:cache-block-dispatcher",
  ]
  cache-to = ["type=registry,ref=${ECR_REGISTRY}/${SCHEDULER_ECR_REPO}:cache-block-dispatcher,mode=max"]
  attest   = []
}

target "executor" {
  context    = "."
  dockerfile = "Dockerfile"
  target     = "executor"
  tags = compact([
    "${ECR_REGISTRY}/${EXECUTOR_ECR_REPO}:executor-${IMAGE_TAG}",
    "${ECR_REGISTRY}/${EXECUTOR_ECR_REPO}:executor-latest",
    ENVIRONMENT_TAG != "" ? "${ECR_REGISTRY}/${EXECUTOR_ECR_REPO}:${ENVIRONMENT_TAG}" : "",
  ])
  cache-from = ["type=registry,ref=${ECR_REGISTRY}/${EXECUTOR_ECR_REPO}:cache"]
  cache-to   = ["type=registry,ref=${ECR_REGISTRY}/${EXECUTOR_ECR_REPO}:cache,mode=max"]
  attest     = []
}
