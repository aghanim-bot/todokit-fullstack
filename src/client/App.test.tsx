// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../shared/types";
import { App } from "./App";

const rootId = "11111111-1111-4111-8111-111111111111";
let tasks: Task[];
let fetchMock: ReturnType<typeof vi.fn>;

function task(patch: Partial<Task> = {}): Task {
  return {
    id: rootId,
    parentId: null,
    title: "Existing task",
    notes: "",
    dueAt: null,
    reviewAt: null,
    recurrence: null,
    completed: false,
    completedAt: null,
    flagged: false,
    position: 0,
    createdAt: "2026-07-27T00:00:00.000Z",
    updatedAt: "2026-07-27T00:00:00.000Z",
    tags: ["work"],
    depth: 0,
    children: [],
    ...patch
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" }
  });
}

beforeEach(() => {
  tasks = [task()];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url === "/api/tasks" && method === "GET") return json({ data: structuredClone(tasks) });
    if (url === "/api/tasks" && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { rawText: string };
      const created = task({
        id: "22222222-2222-4222-8222-222222222222",
        title: body.rawText,
        position: tasks.length,
        tags: []
      });
      tasks.push(created);
      return json({ data: created }, 201);
    }
    const completion = url.match(/^\/api\/tasks\/([^/]+)\/completion$/);
    if (completion && method === "POST") {
      const body = JSON.parse(String(init?.body)) as { completed: boolean };
      tasks = tasks.map(item => item.id === completion[1] ? { ...item, completed: body.completed } : item);
      return json({ data: tasks.find(item => item.id === completion[1]) });
    }
    const update = url.match(/^\/api\/tasks\/([^/]+)$/);
    if (update && method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as Partial<Task>;
      tasks = tasks.map(item => item.id === update[1] ? { ...item, ...body } : item);
      return json({ data: tasks.find(item => item.id === update[1]) });
    }
    return json({ error: { code: "NOT_FOUND", message: "Not found" } }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("App", () => {
  it("shows a real loading state and Todokit's empty state", async () => {
    let resolveRequest: ((response: Response) => void) | undefined;
    fetchMock.mockImplementationOnce(() => new Promise(resolve => { resolveRequest = resolve; }));
    render(<App/>);
    expect(screen.getByRole("heading", { name: "Loading tasks" })).toBeVisible();
    tasks = [];
    await waitFor(() => expect(resolveRequest).toBeTypeOf("function"));
    resolveRequest?.(json({ data: [] }));
    expect(await screen.findByText("All clear")).toBeVisible();
  });

  it("creates a task through quick entry and refreshes backend data", async () => {
    const user = userEvent.setup();
    render(<App/>);
    await screen.findByText("Existing task");
    await user.type(screen.getByRole("textbox", { name: "Quick entry" }), "New task{enter}");
    expect(await screen.findByText("New task")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks", expect.objectContaining({ method: "POST" }));
    expect(screen.getByRole("textbox", { name: "Quick entry" })).toHaveValue("");
  });

  it("completes tasks and edits details through Todokit controls", async () => {
    const user = userEvent.setup();
    render(<App/>);
    await screen.findByText("Existing task");
    await user.click(screen.getByText("Existing task"));
    const notes = screen.getByPlaceholderText("Add notes…");
    fireEvent.change(notes, { target: { value: "Backend details" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${rootId}`,
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ notes: "Backend details" }) })
    ));

    await user.click(screen.getByLabelText("Complete Existing task"));
    await waitFor(() => expect(screen.queryByLabelText("Complete Existing task")).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${rootId}/completion`,
      expect.objectContaining({ method: "POST" })
    );
  });

  it("renders server errors with a retry action", async () => {
    fetchMock.mockResolvedValueOnce(json({
      error: { code: "INTERNAL_ERROR", message: "Database unavailable" }
    }, 500));
    render(<App/>);
    expect(await screen.findByRole("alert")).toHaveTextContent("Database unavailable");
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
  });
});
