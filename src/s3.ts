import { S3Client } from "@aws-sdk/client-s3";

export const s3 = new S3Client({ region: process.env.AWS_REGION || "ap-southeast-1" });
export const ATTACHMENTS_BUCKET = process.env.ATTACHMENTS_BUCKET || "";
export const PRESIGNED_URL_TTL_SECONDS = Number(process.env.PRESIGNED_URL_TTL_SECONDS || 600);
