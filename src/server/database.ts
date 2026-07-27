import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const DEFAULT_DB_PATH = resolve("data/todos.sqlite");

const migrations = [
  `
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 500),
      notes TEXT NOT NULL DEFAULT '',
      due_at TEXT,
      review_at TEXT,
      recurrence TEXT,
      completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1)),
      completed_at TEXT,
      flagged INTEGER NOT NULL DEFAULT 0 CHECK (flagged IN (0, 1)),
      position INTEGER NOT NULL CHECK (position >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (completed = 0 AND completed_at IS NULL)
        OR (completed = 1 AND completed_at IS NOT NULL)
      ),
      CHECK (parent_id IS NULL OR parent_id <> id)
    );

    CREATE TABLE tags (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE
        CHECK (length(name) BETWEEN 1 AND 50)
    );

    CREATE TABLE task_tags (
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      PRIMARY KEY (task_id, tag_id)
    );

    CREATE INDEX idx_tasks_parent_position ON tasks(parent_id, position, created_at, id);
    CREATE INDEX idx_tasks_due_at ON tasks(due_at) WHERE due_at IS NOT NULL;
    CREATE INDEX idx_tasks_review_at ON tasks(review_at) WHERE review_at IS NOT NULL;
    CREATE INDEX idx_tasks_completed ON tasks(completed);
    CREATE INDEX idx_task_tags_tag ON task_tags(tag_id, task_id);

    CREATE TRIGGER prune_unused_tag_after_unlink
    AFTER DELETE ON task_tags
    BEGIN
      DELETE FROM tags
      WHERE id = OLD.tag_id
        AND NOT EXISTS (SELECT 1 FROM task_tags WHERE tag_id = OLD.tag_id);
    END;
  `
] as const;

function migrate(db: Database.Database): void {
  const currentVersion = db.pragma("user_version", { simple: true }) as number;
  if (currentVersion > migrations.length) {
    throw new Error(`Database schema version ${currentVersion} is newer than this application supports`);
  }
  for (let index = currentVersion; index < migrations.length; index += 1) {
    const migration = migrations[index];
    if (!migration) continue;
    db.transaction(() => {
      db.exec(migration);
      db.pragma(`user_version = ${index + 1}`);
    })();
  }
}

export function openDatabase(path = process.env.TODO_DB_PATH || DEFAULT_DB_PATH): Database.Database {
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  if (path !== ":memory:") db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  migrate(db);
  return db;
}
