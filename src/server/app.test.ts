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
    expect((await app.inject({ method: "GET", url: "/api/tasks" })).json().data).toEqual([]);
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
