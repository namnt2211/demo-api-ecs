#!/usr/bin/env bash
# Tao bucket private cho attachments: Block Public Access bat, ma hoa mac dinh bat.
# Usage: ./scripts/create-attachments-bucket.sh teamboard-attachments-<ten> ap-southeast-1
set -euo pipefail

BUCKET="${1:?Usage: ./create-attachments-bucket.sh <bucket-name> [region]}"
REGION="${2:-ap-southeast-1}"

aws s3api create-bucket \
  --bucket "$BUCKET" \
  --region "$REGION" \
  --create-bucket-configuration LocationConstraint="$REGION"

aws s3api put-public-access-block \
  --bucket "$BUCKET" \
  --public-access-block-configuration BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true

aws s3api put-bucket-encryption \
  --bucket "$BUCKET" \
  --server-side-encryption-configuration '{"Rules":[{"ApplyServerSideEncryptionByDefault":{"SSEAlgorithm":"AES256"}}]}'

echo "Bucket $BUCKET da tao, Block Public Access ON, ma hoa mac dinh ON."
