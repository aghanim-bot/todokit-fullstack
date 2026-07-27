import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { openDatabase } from "./database.js";

let db: Database.Database;
let app: FastifyInstance;

beforeEach(async () => {
  db = openDatabase(":memory:");
  app = await createApp(db, { staticDir: false });
});

afterEach(async () => {
  await app.close();
  db.close();
});

async function create(body: Record<string, unknown>) {
  return app.inject({ method: "POST", url: "/api/tasks", payload: body });
}

describe("task API", () => {
  it("creates parsed tasks and returns the recursive tree", async () => {
    const response = await create({
      rawText: "Submit report tomorrow at 5pm every weekday #work #urgent"
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({
      title: "Submit report",
      dueAt: expect.stringMatching(/T17:00:00\.000Z$/),
      recurrence: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
      tags: ["urgent", "work"]
    });

    const list = await app.inject({ method: "GET", url: "/api/tasks" });
    expect(list.statusCode).toBe(200);
    expect(list.json().data[0].title).toBe("Submit report");
  });

  it("uses one consistent validation error shape", async () => {
    const response = await create({ title: "", unknown: true });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        message: "Request validation failed",
        details: expect.any(Array)
      }
    });
  });

  it("wraps malformed JSON and oversized payload errors consistently", async () => {
    const malformed = await app.inject({
      method: "POST",
      url: "/api/tasks",
      headers: { "content-type": "application/json" },
      payload: "{\"title\":"
    });
    expect(malformed.statusCode).toBe(400);
    expect(malformed.json()).toEqual({
      error: { code: "INVALID_REQUEST", message: "Request could not be parsed" }
    });

    const oversized = await create({ title: "x".repeat(70_000) });
    expect(oversized.statusCode).toBe(413);
    expect(oversized.json()).toEqual({
      error: { code: "PAYLOAD_TOO_LARGE", message: "Request body is too large" }
    });
  });

  it("rejects invalid parser and recurrence input", async () => {
    const parsed = await create({ rawText: "Pay due 2026-02-30" });
    expect(parsed.statusCode).toBe(422);
    expect(parsed.json()).toMatchObject({ error: { code: "PARSE_ERROR" } });

    const recurrence = await create({ title: "Task", recurrence: "whenever" });
    expect(recurrence.statusCode).toBe(422);
    expect(recurrence.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
  });

  it("supports subtasks, tags, updates, completion, and subtree deletion", async () => {
    const root = (await create({ title: "Root", tags: ["work"] })).json().data;
    const child = (await create({ title: "Child", parentId: root.id })).json().data;

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${child.id}`,
      payload: { notes: "Details", tags: ["focus"], flagged: true }
    });
    expect(updated.json().data).toMatchObject({ notes: "Details", tags: ["focus"], flagged: true });

    const completed = await app.inject({
      method: "POST",
      url: `/api/tasks/${child.id}/completion`,
      payload: { completed: true }
    });
    expect(completed.json().data.completed).toBe(true);

    const deleted = await app.inject({ method: "DELETE", url: `/api/tasks/${root.id}` });
    expect(deleted.json().data.deleted).toBe(2);
    expect(deleted.json().data.subtree).toMatchObject({
      id: root.id,
      tags: ["work"],
      children: [{ id: child.id, title: "Child" }]
    });
    expect((await app.inject({ method: "GET", url: "/api/tasks" })).json().data).toEqual([]);
  });

  it("patches editable raw text through the same parser path as creation", async () => {
    const original = (await create({
      title: "Original",
      notes: "preserved",
      reviewAt: "2026-08-09",
      flagged: true
    })).json().data;
    const response = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${original.id}`,
      payload: {
        rawText: "Edited due 2026-08-01 at 5:30pm every weekday #Work"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      title: "Edited",
      dueAt: "2026-08-01T17:30:00.000Z",
      recurrence: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
      tags: ["work"],
      notes: "preserved",
      reviewAt: "2026-08-09",
      flagged: true
    });
  });

  it("moves and restores exact subtrees through validated transactional endpoints", async () => {
    const first = (await create({ title: "First" })).json().data;
    const second = (await create({ title: "Second" })).json().data;
    const child = (await create({ title: "Child", parentId: first.id, tags: ["nested"] })).json().data;

    const moved = await app.inject({
      method: "POST",
      url: `/api/tasks/${second.id}/move`,
      payload: { parentId: first.id, position: 0 }
    });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().data).toMatchObject({ parentId: first.id, position: 0 });

    const cycle = await app.inject({
      method: "POST",
      url: `/api/tasks/${first.id}/move`,
      payload: { parentId: child.id, position: 0 }
    });
    expect(cycle.statusCode).toBe(409);
    expect((await app.inject({ method: "GET", url: "/api/tasks" })).json().data[0].id).toBe(first.id);

    const deleted = (await app.inject({
      method: "DELETE",
      url: `/api/tasks/${first.id}`
    })).json().data;
    const restored = await app.inject({
      method: "POST",
      url: "/api/tasks/restore",
      payload: { subtree: deleted.subtree }
    });
    expect(restored.statusCode).toBe(201);
    expect(restored.json().data).toEqual(deleted.subtree);
  });

  it("rejects malformed restore snapshots without opening a sibling gap", async () => {
    const before = (await create({ title: "Before" })).json().data;
    const removed = (await create({ title: "Removed", recurrence: "daily" })).json().data;
    const after = (await create({ title: "After" })).json().data;
    const snapshot = (await app.inject({
      method: "DELETE",
      url: `/api/tasks/${removed.id}`
    })).json().data.subtree;
    snapshot.recurrence = "whenever";
    snapshot.completed = true;
    snapshot.completedAt = null;

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/restore",
      payload: { subtree: snapshot }
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "VALIDATION_ERROR" } });
    expect((await app.inject({ method: "GET", url: "/api/tasks" })).json().data)
      .toEqual([
        expect.objectContaining({ id: before.id, position: 0 }),
        expect.objectContaining({ id: after.id, position: 1 })
      ]);
  });

  it("rejects structurally inconsistent restore snapshots at validation", async () => {
    const root = (await create({ title: "Root" })).json().data;
    await create({ title: "Child", parentId: root.id });
    const snapshot = (await app.inject({
      method: "DELETE",
      url: `/api/tasks/${root.id}`
    })).json().data.subtree;
    snapshot.children[0].depth = 7;

    const response = await app.inject({
      method: "POST",
      url: "/api/tasks/restore",
      payload: { subtree: snapshot }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      error: {
        code: "VALIDATION_ERROR",
        details: expect.arrayContaining([
          expect.objectContaining({ path: "subtree.children.0.depth" })
        ])
      }
    });
    expect((await app.inject({ method: "GET", url: "/api/tasks" })).json().data).toEqual([]);
  });

  it("supports every exact inverse flow used by client undo", async () => {
    const created = (await create({ title: "Original" })).json().data;

    const edited = (await app.inject({
      method: "PATCH",
      url: `/api/tasks/${created.id}`,
      payload: { title: "Edited", dueAt: "2026-08-01", recurrence: "daily", tags: ["work"] }
    })).json().data;
    expect((await app.inject({
      method: "PATCH",
      url: `/api/tasks/${created.id}`,
      payload: {
        title: created.title,
        dueAt: created.dueAt,
        recurrence: created.recurrence,
        tags: created.tags
      }
    })).json().data).toMatchObject({
      title: created.title,
      dueAt: created.dueAt,
      recurrence: created.recurrence,
      tags: created.tags
    });

    await app.inject({
      method: "POST",
      url: `/api/tasks/${created.id}/completion`,
      payload: { completed: true }
    });
    expect((await app.inject({
      method: "POST",
      url: `/api/tasks/${created.id}/completion`,
      payload: { completed: false }
    })).json().data.completed).toBe(false);

    const deleted = (await app.inject({
      method: "DELETE",
      url: `/api/tasks/${created.id}`
    })).json().data;
    expect(edited).toMatchObject({
      title: "Edited",
      dueAt: "2026-08-01",
      recurrence: "RRULE:FREQ=DAILY",
      tags: ["work"]
    });
    expect(deleted.subtree).toMatchObject({
      id: created.id,
      title: "Original",
      dueAt: null,
      recurrence: null,
      tags: [],
      completed: false
    });
    await app.inject({
      method: "POST",
      url: "/api/tasks/restore",
      payload: { subtree: deleted.subtree }
    });
    expect((await app.inject({
      method: "DELETE",
      url: `/api/tasks/${created.id}`
    })).json().data.deleted).toBe(1);
  });

  it("reports cycle, missing task, unknown route, and health states correctly", async () => {
    const root = (await create({ title: "Root" })).json().data;
    const child = (await create({ title: "Child", parentId: root.id })).json().data;
    const cycle = await app.inject({
      method: "PATCH",
      url: `/api/tasks/${root.id}`,
      payload: { parentId: child.id }
    });
    expect(cycle.statusCode).toBe(409);
    expect(cycle.json()).toMatchObject({ error: { code: "CONFLICT" } });

    const missingId = "00000000-0000-4000-8000-000000000000";
    const missing = await app.inject({ method: "GET", url: `/api/tasks/${missingId}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "NOT_FOUND" } });

    expect((await app.inject({ method: "GET", url: "/api/nope" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/health" })).json()).toEqual({ status: "ok" });
  });
});
