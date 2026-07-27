import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Task } from "../shared/types.js";
import { ConflictError, NotFoundError } from "./errors.js";

interface TaskRow {
  id: string;
  parent_id: string | null;
  title: string;
  notes: string;
  due_at: string | null;
  review_at: string | null;
  recurrence: string | null;
  completed: number;
  completed_at: string | null;
  flagged: number;
  position: number;
  created_at: string;
  updated_at: string;
  depth: number;
  tags_json: string;
}

export interface CreateTaskInput {
  parentId?: string | null;
  title: string;
  notes?: string;
  dueAt?: string | null;
  reviewAt?: string | null;
  recurrence?: string | null;
  completed?: boolean;
  flagged?: boolean;
  tags?: string[];
}

export interface UpdateTaskInput {
  parentId?: string | null;
  title?: string;
  notes?: string;
  dueAt?: string | null;
  reviewAt?: string | null;
  recurrence?: string | null;
  completed?: boolean;
  flagged?: boolean;
  tags?: string[];
}

const selectColumns = `
  tree.id, tree.parent_id, tree.title, tree.notes, tree.due_at, tree.review_at, tree.recurrence,
  tree.completed, tree.completed_at, tree.flagged, tree.position,
  tree.created_at, tree.updated_at, tree.depth,
  COALESCE((
    SELECT json_group_array(name) FROM (
      SELECT tags.name AS name
      FROM task_tags
      JOIN tags ON tags.id = task_tags.tag_id
      WHERE task_tags.task_id = tree.id
      ORDER BY tags.name COLLATE NOCASE
    )
  ), '[]') AS tags_json
`;

const listTreeSql = `
  WITH RECURSIVE tree AS (
    SELECT tasks.*, 0 AS depth,
      printf('%012d:%s', position, id) AS sort_path
    FROM tasks
    WHERE parent_id IS NULL
    UNION ALL
    SELECT child.*, tree.depth + 1,
      tree.sort_path || '/' || printf('%012d:%s', child.position, child.id)
    FROM tasks AS child
    JOIN tree ON child.parent_id = tree.id
  )
  SELECT ${selectColumns}
  FROM tree
  ORDER BY tree.sort_path
`;

const getSubtreeSql = `
  WITH RECURSIVE tree AS (
    SELECT tasks.*, 0 AS depth,
      printf('%012d:%s', position, id) AS sort_path
    FROM tasks
    WHERE id = ?
    UNION ALL
    SELECT child.*, tree.depth + 1,
      tree.sort_path || '/' || printf('%012d:%s', child.position, child.id)
    FROM tasks AS child
    JOIN tree ON child.parent_id = tree.id
  )
  SELECT ${selectColumns}
  FROM tree
  ORDER BY tree.sort_path
`;

function mapRow(row: TaskRow): Task {
  return {
    id: row.id,
    parentId: row.parent_id,
    title: row.title,
    notes: row.notes,
    dueAt: row.due_at,
    reviewAt: row.review_at,
    recurrence: row.recurrence,
    completed: Boolean(row.completed),
    completedAt: row.completed_at,
    flagged: Boolean(row.flagged),
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    tags: JSON.parse(row.tags_json) as string[],
    depth: row.depth,
    children: []
  };
}

function rowsToTree(rows: TaskRow[]): Task[] {
  const mapped = rows.map(mapRow);
  const byId = new Map(mapped.map(task => [task.id, task]));
  const roots: Task[] = [];
  for (const task of mapped) {
    const parent = task.parentId ? byId.get(task.parentId) : undefined;
    if (parent) parent.children.push(task);
    else roots.push(task);
  }
  return roots;
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map(tag => tag.trim().replace(/^#/, "").toLocaleLowerCase("en-US")))]
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right));
}

export class TaskRepository {
  constructor(private readonly db: Database.Database) {}

  listTree(): Task[] {
    return rowsToTree(this.db.prepare(listTreeSql).all() as TaskRow[]);
  }

  get(id: string): Task {
    const rows = this.db.prepare(getSubtreeSql).all(id) as TaskRow[];
    const task = rowsToTree(rows)[0];
    if (!task) throw new NotFoundError();
    return task;
  }

  create(input: CreateTaskInput): Task {
    const id = randomUUID();
    const timestamp = new Date().toISOString();
    this.db.transaction(() => {
      this.validateParent(input.parentId ?? null);
      const position = this.nextPosition(input.parentId ?? null);
      const completed = input.completed ?? false;
      this.db.prepare(`
        INSERT INTO tasks (
          id, parent_id, title, notes, due_at, review_at, recurrence, completed,
          completed_at, flagged, position, created_at, updated_at
        ) VALUES (
          @id, @parentId, @title, @notes, @dueAt, @reviewAt, @recurrence, @completed,
          @completedAt, @flagged, @position, @createdAt, @updatedAt
        )
      `).run({
        id,
        parentId: input.parentId ?? null,
        title: input.title,
        notes: input.notes ?? "",
        dueAt: input.dueAt ?? null,
        reviewAt: input.reviewAt ?? null,
        recurrence: input.recurrence ?? null,
        completed: completed ? 1 : 0,
        completedAt: completed ? timestamp : null,
        flagged: input.flagged ? 1 : 0,
        position,
        createdAt: timestamp,
        updatedAt: timestamp
      });
      this.replaceTags(id, input.tags ?? []);
    })();
    return this.get(id);
  }

  update(id: string, patch: UpdateTaskInput): Task {
    this.db.transaction(() => {
      const current = this.getFlat(id);
      const parentId = patch.parentId !== undefined ? patch.parentId : current.parent_id;
      if (patch.parentId !== undefined && parentId !== current.parent_id) {
        this.validateMove(id, parentId);
      }
      const completed = patch.completed ?? Boolean(current.completed);
      const completedAt = completed
        ? (current.completed ? current.completed_at : new Date().toISOString())
        : null;
      const position = parentId === current.parent_id ? current.position : this.nextPosition(parentId);
      this.db.prepare(`
        UPDATE tasks SET
          parent_id = @parentId,
          title = @title,
          notes = @notes,
          due_at = @dueAt,
          review_at = @reviewAt,
          recurrence = @recurrence,
          completed = @completed,
          completed_at = @completedAt,
          flagged = @flagged,
          position = @position,
          updated_at = @updatedAt
        WHERE id = @id
      `).run({
        id,
        parentId,
        title: patch.title ?? current.title,
        notes: patch.notes ?? current.notes,
        dueAt: patch.dueAt !== undefined ? patch.dueAt : current.due_at,
        reviewAt: patch.reviewAt !== undefined ? patch.reviewAt : current.review_at,
        recurrence: patch.recurrence !== undefined ? patch.recurrence : current.recurrence,
        completed: completed ? 1 : 0,
        completedAt,
        flagged: (patch.flagged ?? Boolean(current.flagged)) ? 1 : 0,
        position,
        updatedAt: new Date().toISOString()
      });
      if (patch.tags) this.replaceTags(id, patch.tags);
    })();
    return this.get(id);
  }

  setCompleted(id: string, completed: boolean): Task {
    return this.update(id, { completed });
  }

  deleteSubtree(id: string): number {
    return this.db.transaction(() => {
      this.getFlat(id);
      const count = this.db.prepare(`
        WITH RECURSIVE subtree(id) AS (
          SELECT id FROM tasks WHERE id = ?
          UNION ALL
          SELECT tasks.id
          FROM tasks
          JOIN subtree ON tasks.parent_id = subtree.id
        )
        SELECT count(*) AS count FROM subtree
      `).get(id) as { count: number };
      this.db.prepare(`
        WITH RECURSIVE subtree(id) AS (
          SELECT id FROM tasks WHERE id = ?
          UNION ALL
          SELECT tasks.id
          FROM tasks
          JOIN subtree ON tasks.parent_id = subtree.id
        )
        DELETE FROM tasks WHERE id IN (SELECT id FROM subtree)
      `).run(id);
      return count.count;
    })();
  }

  private getFlat(id: string): Omit<TaskRow, "depth" | "tags_json"> {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    if (!row) throw new NotFoundError();
    return row as Omit<TaskRow, "depth" | "tags_json">;
  }

  private validateParent(parentId: string | null): void {
    if (parentId && !this.db.prepare("SELECT 1 FROM tasks WHERE id = ?").get(parentId)) {
      throw new NotFoundError("Parent task not found");
    }
  }

  private validateMove(id: string, parentId: string | null): void {
    this.validateParent(parentId);
    if (!parentId) return;
    const descendant = this.db.prepare(`
      WITH RECURSIVE descendants(id) AS (
        SELECT id FROM tasks WHERE id = ?
        UNION ALL
        SELECT tasks.id
        FROM tasks
        JOIN descendants ON tasks.parent_id = descendants.id
      )
      SELECT 1 FROM descendants WHERE id = ?
    `).get(id, parentId);
    if (descendant) throw new ConflictError("A task cannot be moved beneath itself or its descendants");
  }

  private nextPosition(parentId: string | null): number {
    const row = parentId
      ? this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM tasks WHERE parent_id = ?").get(parentId)
      : this.db.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS position FROM tasks WHERE parent_id IS NULL").get();
    return (row as { position: number }).position;
  }

  private replaceTags(taskId: string, tags: string[]): void {
    this.db.prepare("DELETE FROM task_tags WHERE task_id = ?").run(taskId);
    const insertTag = this.db.prepare("INSERT INTO tags(name) VALUES (?) ON CONFLICT(name) DO NOTHING");
    const linkTag = this.db.prepare(`
      INSERT INTO task_tags(task_id, tag_id)
      SELECT ?, id FROM tags WHERE name = ? COLLATE NOCASE
    `);
    for (const tag of normalizeTags(tags)) {
      insertTag.run(tag);
      linkTag.run(taskId, tag);
    }
    this.db.prepare(`
      DELETE FROM tags
      WHERE NOT EXISTS (SELECT 1 FROM task_tags WHERE task_tags.tag_id = tags.id)
    `).run();
  }
}
