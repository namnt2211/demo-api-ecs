import express from "express";
import { pool, ensureSchema } from "./db";
import { itemsRouter } from "./routes/items";
import { tasksRouter } from "./routes/tasks";
import { attachmentsRouter } from "./routes/attachments";

const app = express();
const port = Number(process.env.PORT || 3000);

app.use(express.json());

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch (err) {
    res.status(503).json({ status: "db_unreachable", error: (err as Error).message });
  }
});

app.use("/items", itemsRouter);
app.use("/api/tasks", tasksRouter);
app.use("/api", attachmentsRouter);

async function start() {
  await ensureSchema();
  app.listen(port, () => {
    console.log(`demo-api listening on port ${port}`);
  });
}

start().catch((err) => {
  console.error("failed to start server", err);
  process.exit(1);
});
