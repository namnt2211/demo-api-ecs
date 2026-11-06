import { readdirSync, readFileSync } from "fs";
import path from "path";
import { pool } from "./db";

async function migrate(): Promise<void> {
  const dir = path.join(__dirname, "..", "migrations");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const sql = readFileSync(path.join(dir, file), "utf-8");
    console.log(`Applying migration: ${file}`);
    await pool.query(sql);
  }

  console.log("Migrations applied.");
  await pool.end();
}

migrate().catch((err) => {
  console.error("Migration failed", err);
  process.exit(1);
});
