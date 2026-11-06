#!/usr/bin/env bash
# Build the Docker image and push it to the ECR repo created by Terraform.
# Usage: ./scripts/push-to-ecr.sh [image_tag]
set -euo pipefail

TAG="${1:-latest}"
cd "$(dirname "$0")/.."

REPO_URL=$(terraform -chdir=terraform output -raw ecr_repository_url)
REGION=$(terraform -chdir=terraform output -raw aws_region)
REGISTRY="${REPO_URL%%/*}"

echo "Logging in to ECR: ${REGISTRY}"
aws ecr get-login-password --region "${REGION}" | docker login --username AWS --password-stdin "${REGISTRY}"

echo "Building image..."
docker build -t "${REPO_URL}:${TAG}" .

echo "Pushing ${REPO_URL}:${TAG}"
docker push "${REPO_URL}:${TAG}"

echo "Done. Image: ${REPO_URL}:${TAG}"
