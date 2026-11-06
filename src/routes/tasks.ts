import { Router, Request, Response } from "express";
import { pool } from "../db";

// Minimal CRUD, only here so attachments have a task_id to test against.
export const tasksRouter = Router();

tasksRouter.get("/", async (_req: Request, res: Response) => {
  const result = await pool.query("SELECT id, title, created_at FROM tasks ORDER BY id DESC");
  res.json(result.rows);
});

tasksRouter.post("/", async (req: Request, res: Response) => {
  const { title } = req.body;
  if (!title || typeof title !== "string") {
    res.status(400).json({ error: "title is required" });
    return;
  }
  const result = await pool.query(
    "INSERT INTO tasks (title) VALUES ($1) RETURNING id, title, created_at",
    [title]
  );
  res.status(201).json(result.rows[0]);
});
