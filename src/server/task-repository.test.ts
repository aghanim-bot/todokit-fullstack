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

    expect(repository.deleteSubtree(root.id)).toMatchObject({
      deleted: 3,
      subtree: { id: root.id, children: [{ id: child.id }] }
    });
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

  it("moves tasks transactionally and reindexes source and target siblings", async () => {
    const { repository } = await temporaryRepository();
    const first = repository.create({ title: "First" });
    const second = repository.create({ title: "Second" });
    const third = repository.create({ title: "Third" });
    repository.create({ title: "Child", parentId: first.id });

    repository.move(third.id, { parentId: first.id, position: 0 });
    expect(repository.listTree().map(item => [item.title, item.position])).toEqual([
      ["First", 0],
      ["Second", 1]
    ]);
    expect(repository.get(first.id).children.map(item => [item.title, item.position])).toEqual([
      ["Third", 0],
      ["Child", 1]
    ]);

    repository.move(first.id, { parentId: null, position: 1 });
    expect(repository.listTree().map(item => [item.title, item.position])).toEqual([
      ["Second", 0],
      ["First", 1]
    ]);
    expect(repository.get(second.id)).toMatchObject({ parentId: null, position: 0 });
  });

  it("rejects cyclic, missing-parent, and out-of-range moves without changing any order", async () => {
    const { repository } = await temporaryRepository();
    const root = repository.create({ title: "Root" });
    const sibling = repository.create({ title: "Sibling" });
    const child = repository.create({ title: "Child", parentId: root.id });
    const before = repository.listTree();

    expect(() => repository.move(root.id, { parentId: child.id, position: 0 })).toThrowError(/descendants/);
    expect(() => repository.move(sibling.id, { parentId: "missing", position: 0 })).toThrowError(/Parent/);
    expect(() => repository.move(sibling.id, { parentId: null, position: 5 })).toThrowError(/position/i);
    expect(repository.listTree()).toEqual(before);
  });

  it("rolls back sibling reindexing when the final move update fails", async () => {
    const { db, repository } = await temporaryRepository();
    const root = repository.create({ title: "Root" });
    repository.create({ title: "Existing child", parentId: root.id });
    const moving = repository.create({ title: "Moving" });
    const before = repository.listTree();
    db.exec(`
      CREATE TRIGGER reject_test_move
      BEFORE UPDATE OF parent_id ON tasks
      WHEN OLD.id = '${moving.id}'
      BEGIN
        SELECT RAISE(ABORT, 'test move failure');
      END;
    `);

    expect(() => repository.move(moving.id, { parentId: root.id, position: 0 }))
      .toThrowError(/test move failure/);
    expect(repository.listTree()).toEqual(before);
  });

  it("restores an exact recursively deleted subtree including IDs, order, tags, and every field", async () => {
    const { repository } = await temporaryRepository();
    repository.create({ title: "Before" });
    const root = repository.create({
      title: "Restore me",
      notes: "Details",
      dueAt: "2026-08-01",
      reviewAt: "2026-08-02",
      recurrence: "RRULE:FREQ=DAILY",
      completed: true,
      flagged: true,
      tags: ["urgent", "work"]
    });
    const child = repository.create({ title: "Child", parentId: root.id, tags: ["nested"] });
    repository.create({ title: "Grandchild", parentId: child.id, dueAt: "2026-08-03" });
    repository.create({ title: "After" });
    const snapshot = repository.get(root.id);

    const deleted = repository.deleteSubtree(root.id);
    expect(deleted).toEqual({ deleted: 3, subtree: snapshot });
    expect(repository.listTree().map(item => [item.title, item.position])).toEqual([
      ["Before", 0],
      ["After", 1]
    ]);

    expect(repository.restoreSubtree(deleted.subtree)).toEqual(snapshot);
    expect(repository.listTree()).toEqual([
      expect.objectContaining({ title: "Before", position: 0 }),
      snapshot,
      expect.objectContaining({ title: "After", position: 2 })
    ]);
  });

  it("rolls back restore entirely when a descendant ID already exists", async () => {
    const { repository } = await temporaryRepository();
    const root = repository.create({ title: "Root" });
    const child = repository.create({ title: "Child", parentId: root.id });
    const snapshot = repository.deleteSubtree(root.id).subtree;
    repository.restoreSubtree({ ...child, parentId: null, depth: 0, children: [] });
    const before = repository.listTree();

    expect(() => repository.restoreSubtree(snapshot)).toThrowError(/already exists/i);
    expect(repository.listTree()).toEqual(before);
  });

  it("rolls back an opened restore gap and prior inserts after a descendant constraint failure", async () => {
    const { repository } = await temporaryRepository();
    repository.create({ title: "Before" });
    const root = repository.create({ title: "Root" });
    repository.create({ title: "Child", parentId: root.id });
    repository.create({ title: "After" });
    const snapshot = repository.deleteSubtree(root.id).subtree;
    const malformedChild = snapshot.children[0];
    if (!malformedChild) throw new Error("Expected child fixture");
    malformedChild.completed = true;
    malformedChild.completedAt = null;
    const before = repository.listTree();

    expect(() => repository.restoreSubtree(snapshot)).toThrow();
    expect(repository.listTree()).toEqual(before);
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
