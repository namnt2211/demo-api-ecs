import { Router, Request, Response } from "express";
import { randomUUID } from "crypto";
import { PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { pool } from "../db";
import { s3, ATTACHMENTS_BUCKET, PRESIGNED_URL_TTL_SECONDS } from "../s3";

export const attachmentsRouter = Router();

// POST /api/tasks/:id/attachments/upload-url
attachmentsRouter.post("/tasks/:id/attachments/upload-url", async (req: Request, res: Response) => {
  const taskId = Number(req.params.id);
  const { filename, contentType } = req.body;

  if (!filename || typeof filename !== "string") {
    res.status(400).json({ error: "filename is required" });
    return;
  }

  const task = await pool.query("SELECT id FROM tasks WHERE id = $1", [taskId]);
  if (task.rowCount === 0) {
    res.status(404).json({ error: "task not found" });
    return;
  }

  const safeContentType = typeof contentType === "string" ? contentType : "application/octet-stream";
  const s3Key = `tasks/${taskId}/${randomUUID()}-${filename}`;

  const uploadUrl = await getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: ATTACHMENTS_BUCKET,
      Key: s3Key,
      ContentType: safeContentType,
    }),
    { expiresIn: PRESIGNED_URL_TTL_SECONDS }
  );

  const inserted = await pool.query(
    `INSERT INTO attachments (task_id, filename, s3_key, content_type)
     VALUES ($1, $2, $3, $4)
     RETURNING id, task_id, filename, s3_key, content_type, created_at`,
    [taskId, filename, s3Key, safeContentType]
  );

  res.status(201).json({
    attachment: inserted.rows[0],
    uploadUrl,
    expiresIn: PRESIGNED_URL_TTL_SECONDS,
  });
});

// GET /api/attachments/:id/download-url
attachmentsRouter.get("/attachments/:id/download-url", async (req: Request, res: Response) => {
  const id = Number(req.params.id);

  const result = await pool.query(
    "SELECT id, s3_key, filename FROM attachments WHERE id = $1",
    [id]
  );
  if (result.rowCount === 0) {
    res.status(404).json({ error: "attachment not found" });
    return;
  }
  const attachment = result.rows[0];

  const downloadUrl = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: ATTACHMENTS_BUCKET,
      Key: attachment.s3_key,
      ResponseContentDisposition: `attachment; filename="${attachment.filename}"`,
    }),
    { expiresIn: PRESIGNED_URL_TTL_SECONDS }
  );

  res.json({ downloadUrl, expiresIn: PRESIGNED_URL_TTL_SECONDS });
});
