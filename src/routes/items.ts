import { Router, Request, Response } from "express";
import { pool } from "../db";

export const itemsRouter = Router();

itemsRouter.get("/", async (_req: Request, res: Response) => {
  const result = await pool.query("SELECT id, name, created_at FROM items ORDER BY id DESC");
  res.json(result.rows);
});

itemsRouter.get("/:id", async (req: Request, res: Response) => {
  const result = await pool.query("SELECT id, name, created_at FROM items WHERE id = $1", [req.params.id]);
  if (result.rowCount === 0) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json(result.rows[0]);
});

itemsRouter.post("/", async (req: Request, res: Response) => {
  const { name } = req.body;
  if (!name || typeof name !== "string") {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const result = await pool.query(
    "INSERT INTO items (name) VALUES ($1) RETURNING id, name, created_at",
    [name]
  );
  res.status(201).json(result.rows[0]);
});

itemsRouter.delete("/:id", async (req: Request, res: Response) => {
  const result = await pool.query("DELETE FROM items WHERE id = $1", [req.params.id]);
  if (result.rowCount === 0) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.status(204).send();
});
