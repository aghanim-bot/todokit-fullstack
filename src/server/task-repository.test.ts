import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "./database.js";
import { TaskRepository } from "./task-repository.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
});

async function temporaryRepository() {
  const directory = await mkdtemp(join(tmpdir(), "todokit-"));
  const path = join(directory, "fresh", "nested", "todos.sqlite");
  const db = openDatabase(path);
  cleanups.push(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { db, repository: new TaskRepository(db), path };
}

describe("database initialization", () => {
  it("creates a fresh database and its missing parent directories", async () => {
    const { db, path } = await temporaryRepository();
    expect(existsSync(path)).toBe(true);
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("user_version", { simple: true })).toBe(1);
  });
});

describe("TaskRepository recursive behavior", () => {
  it("returns recursively ordered trees with stable depth values", async () => {
    const { repository } = await temporaryRepository();
    const first = repository.create({ title: "First" });
    repository.create({ title: "Second" });
    const child = repository.create({ title: "Child", parentId: first.id });
    repository.create({ title: "Grandchild", parentId: child.id });
    repository.create({ title: "Sibling", parentId: first.id });

    const tree = repository.listTree();
    expect(tree.map(task => task.title)).toEqual(["First", "Second"]);
    expect(tree[0]?.children.map(task => task.title)).toEqual(["Child", "Sibling"]);
    expect(tree[0]?.children[0]?.children[0]).toMatchObject({ title: "Grandchild", depth: 2 });
  });

  it("deletes a complete subtree and preserves unrelated tasks", async () => {
    const { repository } = await temporaryRepository();
    const root = repository.create({ title: "Root" });
    const child = repository.create({ title: "Child", parentId: root.id });
    repository.create({ title: "Grandchild", parentId: child.id });
    repository.create({ title: "Keep" });

    expect(repository.deleteSubtree(root.id)).toBe(3);
    expect(repository.listTree().map(task => task.title)).toEqual(["Keep"]);
    expect(() => repository.get(child.id)).toThrowError(/not found/i);
  });

  it("prevents cycles and rejects nonexistent parents", async () => {
    const { repository } = await temporaryRepository();
    const root = repository.create({ title: "Root" });
    const child = repository.create({ title: "Child", parentId: root.id });

    expect(() => repository.update(root.id, { parentId: child.id })).toThrowError(/descendants/);
    expect(() => repository.update(root.id, { parentId: root.id })).toThrowError(/beneath itself/);
    expect(() => repository.create({ title: "Orphan", parentId: "missing" })).toThrowError(/Parent task not found/);
  });

  it("normalizes tags and keeps tag links correct through updates and deletion", async () => {
    const { db, repository } = await temporaryRepository();
    const task = repository.create({ title: "Tagged", tags: ["Work", "#urgent", "work"] });
    expect(task.tags).toEqual(["urgent", "work"]);

    expect(repository.update(task.id, { tags: ["home"] }).tags).toEqual(["home"]);
    expect((db.prepare("SELECT count(*) AS count FROM tags").get() as { count: number }).count).toBe(1);
    repository.deleteSubtree(task.id);
    expect((db.prepare("SELECT count(*) AS count FROM tags").get() as { count: number }).count).toBe(0);
  });

  it("completes and reopens tasks consistently", async () => {
    const { repository } = await temporaryRepository();
    const task = repository.create({ title: "Toggle" });
    const complete = repository.setCompleted(task.id, true);
    expect(complete.completed).toBe(true);
    expect(complete.completedAt).toMatch(/Z$/);
    const reopened = repository.setCompleted(task.id, false);
    expect(reopened).toMatchObject({ completed: false, completedAt: null });
  });
});
