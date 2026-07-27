// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseInboxInput } from "../shared/parser";
import type { Task } from "../shared/types";
import { App } from "./App";

const rootId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";
const childId = "33333333-3333-4333-8333-333333333333";
const createdId = "44444444-4444-4444-8444-444444444444";
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

function mapTree(items: Task[], id: string, transform: (item: Task) => Task): Task[] {
  return items.map(item => item.id === id
    ? transform(item)
    : { ...item, children: mapTree(item.children, id, transform) });
}

function find(items: Task[], id: string): Task | undefined {
  for (const item of items) {
    if (item.id === id) return item;
    const nested = find(item.children, id);
    if (nested) return nested;
  }
}

function remove(items: Task[], id: string): Task[] {
  return items
    .filter(item => item.id !== id)
    .map(item => ({ ...item, children: remove(item.children, id) }))
    .map((item, position) => ({ ...item, position }));
}

function insert(items: Task[], parentId: string | null, value: Task, position: number): Task[] {
  if (parentId === null) {
    const next = [...items];
    next.splice(position, 0, { ...value, parentId: null });
    return next.map((item, index) => ({ ...item, position: index }));
  }
  return items.map(item => item.id === parentId
    ? {
      ...item,
      children: [
        ...item.children.slice(0, position),
        { ...value, parentId, depth: item.depth + 1 },
        ...item.children.slice(position)
      ].map((child, index) => ({ ...child, position: index }))
    }
    : { ...item, children: insert(item.children, parentId, value, position) });
}

beforeEach(() => {
  tasks = [task()];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (url === "/api/tasks" && method === "GET") return json({ data: structuredClone(tasks) });
    if (url === "/api/tasks" && method === "POST") {
      const parsed = parseInboxInput(String(body.rawText));
      const parentId = typeof body.parentId === "string" ? body.parentId : null;
      const parent = parentId ? find(tasks, parentId) : undefined;
      const created = task({
        id: createdId,
        parentId,
        title: parsed.title,
        dueAt: parsed.dueAt,
        recurrence: parsed.recurrence,
        tags: parsed.tags,
        position: parent ? parent.children.length : tasks.length,
        depth: parent ? parent.depth + 1 : 0
      });
      tasks = insert(tasks, parentId, created, created.position);
      return json({ data: created }, 201);
    }
    if (url === "/api/tasks/restore" && method === "POST") {
      const subtree = structuredClone(body.subtree) as Task;
      tasks = insert(tasks, subtree.parentId, subtree, subtree.position);
      return json({ data: subtree }, 201);
    }
    const completion = url.match(/^\/api\/tasks\/([^/]+)\/completion$/);
    if (completion && method === "POST") {
      tasks = mapTree(tasks, completion[1] ?? "", item => ({
        ...item,
        completed: Boolean(body.completed),
        completedAt: body.completed ? "2026-07-27T01:00:00.000Z" : null
      }));
      return json({ data: find(tasks, completion[1] ?? "") });
    }
    const move = url.match(/^\/api\/tasks\/([^/]+)\/move$/);
    if (move && method === "POST") {
      const moved = structuredClone(find(tasks, move[1] ?? "")) as Task;
      const withoutMoved = remove(tasks, moved.id);
      const parentId = body.parentId as string | null;
      const targetSiblings = parentId === null
        ? withoutMoved
        : find(withoutMoved, parentId)?.children;
      const position = Number(body.position);
      if (!targetSiblings || position < 0 || position > targetSiblings.length) {
        return json({
          error: { code: "CONFLICT", message: "Move position is outside the sibling list" }
        }, 409);
      }
      tasks = insert(withoutMoved, parentId, moved, position);
      return json({ data: find(tasks, moved.id) });
    }
    const update = url.match(/^\/api\/tasks\/([^/]+)$/);
    if (update && method === "PATCH") {
      const patch = body.rawText
        ? (() => {
          const parsed = parseInboxInput(String(body.rawText));
          return {
            title: parsed.title,
            dueAt: parsed.dueAt,
            recurrence: parsed.recurrence,
            tags: parsed.tags
          };
        })()
        : body;
      tasks = mapTree(tasks, update[1] ?? "", item => ({ ...item, ...patch }));
      return json({ data: find(tasks, update[1] ?? "") });
    }
    if (update && method === "DELETE") {
      const subtree = structuredClone(find(tasks, update[1] ?? "")) as Task;
      const deleted = 1 + subtree.children.length;
      tasks = remove(tasks, subtree.id);
      return json({ data: { deleted, subtree } });
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

  it("highlights live syntax inside quick entry and creates an undoable task", async () => {
    const user = userEvent.setup();
    const { container } = render(<App/>);
    await screen.findByText("Existing task");
    const undo = screen.getByRole("button", { name: "Undo last action" });
    expect(undo).toBeDisabled();

    await user.type(
      screen.getByRole("textbox", { name: "Quick entry" }),
      "New task tomorrow every weekday #work"
    );
    expect([...container.querySelectorAll("mark")].map(mark => [
      mark.textContent,
      mark.getAttribute("data-highlight-kind")
    ])).toEqual(expect.arrayContaining([
      ["tomorrow", "date"],
      ["every weekday", "recurrence"],
      ["#work", "tag"]
    ]));
    await user.keyboard("{Enter}");

    expect(await screen.findByText("New task")).toBeVisible();
    expect(undo).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks", expect.objectContaining({ method: "POST" }));
  });

  it("opens deterministic in-place editing on click and Enter, then commits all parsed fields together", async () => {
    tasks = [task({
      title: "Existing task",
      dueAt: "2026-08-01T17:30:00.000Z",
      recurrence: "RRULE:FREQ=DAILY",
      tags: ["urgent", "work"]
    })];
    const user = userEvent.setup();
    render(<App/>);
    const title = await screen.findByText("Existing task");
    await user.click(title);
    const editor = screen.getByRole("textbox", { name: "Edit Existing task" }) as HTMLInputElement;
    expect(editor).toHaveValue(
      "Existing task due 2026-08-01 at 5:30pm RRULE:FREQ=DAILY #urgent #work"
    );
    await waitFor(() => {
      expect(editor.selectionStart).toBe(0);
      expect(editor.selectionEnd).toBe(editor.value.length);
    });

    await user.clear(editor);
    await user.type(editor, "Changed tomorrow every weekday #Home{Enter}");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${rootId}`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ rawText: "Changed tomorrow every weekday #Home" })
      })
    ));
    expect(await within(screen.getByRole("tree")).findByText("Changed")).toBeVisible();

    const row = within(screen.getByRole("tree")).getByText("Changed").closest("[role=treeitem]");
    expect(row).not.toBeNull();
    (row as HTMLElement | null)?.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("textbox", { name: "Edit Changed" })).toBeVisible();
    await user.keyboard("{Escape}");
    await user.click(screen.getByRole("button", { name: "Undo last action" }));
    expect(await within(screen.getByRole("tree")).findByText("Existing task")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${rootId}`,
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          title: "Existing task",
          dueAt: "2026-08-01T17:30:00.000Z",
          recurrence: "RRULE:FREQ=DAILY",
          tags: ["urgent", "work"]
        })
      })
    );
  });

  it("cancels editing with Escape, restores row focus, and rejects an empty existing edit", async () => {
    const user = userEvent.setup();
    render(<App/>);
    const tree = await screen.findByRole("tree");
    await user.click(within(tree).getByText("Existing task"));
    const editor = screen.getByRole("textbox", { name: "Edit Existing task" });
    await user.clear(editor);
    await user.keyboard("{Enter}");
    expect(within(tree).getByText("Existing task")).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalledWith(
      `/api/tasks/${rootId}`,
      expect.objectContaining({ method: "PATCH" })
    );

    await user.click(within(tree).getByText("Existing task"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(within(tree).getByText("Existing task").closest("[role=treeitem]")).toHaveFocus());
  });

  it("adds an unsaved inline subtask draft without prompt and cancels an empty draft on blur or Escape", async () => {
    const user = userEvent.setup();
    const prompt = vi.spyOn(window, "prompt");
    render(<App/>);
    await user.click(await screen.findByRole("button", { name: "Add subtask to Existing task" }));
    const draft = screen.getByRole("textbox", { name: "New subtask for Existing task" });
    expect(draft).toHaveFocus();
    expect(prompt).not.toHaveBeenCalled();
    fireEvent.blur(draft);
    expect(screen.queryByRole("textbox", { name: "New subtask for Existing task" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add subtask to Existing task" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("textbox", { name: "New subtask for Existing task" })).not.toBeInTheDocument();
  });

  it("saves inline drafts and Shift+Enter commits an existing task then opens its next draft", async () => {
    const user = userEvent.setup();
    render(<App/>);
    await user.click(await screen.findByRole("button", { name: "Add subtask to Existing task" }));
    await user.type(
      screen.getByRole("textbox", { name: "New subtask for Existing task" }),
      "Child #home{Enter}"
    );
    expect(await within(screen.getByRole("tree")).findByText("Child")).toBeVisible();
    expect(fetchMock).toHaveBeenCalledWith("/api/tasks", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ rawText: "Child #home", parentId: rootId })
    }));
    await user.click(screen.getByRole("button", { name: "Undo last action" }));
    await waitFor(() => {
      expect(within(screen.getByRole("tree")).queryByText("Child")).not.toBeInTheDocument();
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${createdId}`,
      expect.objectContaining({ method: "DELETE" })
    );

    tasks = [task()];
    cleanup();
    render(<App/>);
    const rerenderedTree = await screen.findByRole("tree");
    await user.click(within(rerenderedTree).getByText("Existing task"));
    const editor = screen.getByRole("textbox", { name: "Edit Existing task" });
    await user.clear(editor);
    await user.type(editor, "Renamed{Shift>}{Enter}{/Shift}");
    await waitFor(() => expect(screen.getByRole("textbox", { name: "New subtask for Renamed" })).toHaveFocus());
  });

  it("indents and outdents focused/editor tasks with Tab while leaving nested buttons and quick entry native", async () => {
    const child = task({ id: childId, parentId: rootId, title: "Child", depth: 1, tags: [], position: 0 });
    tasks = [
      task({ title: "First", children: [child] }),
      task({ id: secondId, title: "Second", tags: [], position: 1 })
    ];
    const user = userEvent.setup();
    render(<App/>);
    const secondRow = (await screen.findByText("Second")).closest("[role=treeitem]");
    (secondRow as HTMLElement | null)?.focus();
    fireEvent.keyDown(secondRow as HTMLElement, { key: "Tab" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${secondId}/move`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ parentId: rootId, position: 1 })
      })
    ));

    await user.click(within(screen.getByRole("tree")).getByText("Second"));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Edit Second" }), {
      key: "Tab",
      shiftKey: true
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${secondId}/move`,
      expect.objectContaining({
        body: JSON.stringify({ parentId: null, position: 1 })
      })
    ));
    await waitFor(() => expect(fetchMock.mock.calls.filter(([url, init]) =>
      String(url) === "/api/tasks" && (init?.method ?? "GET") === "GET"
    )).toHaveLength(3));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.getByRole("textbox", { name: "Edit Second" })).toHaveFocus();

    const quick = screen.getByRole("textbox", { name: "Quick entry" });
    const moveCalls = () => fetchMock.mock.calls.filter(([url]) => String(url).includes("/move")).length;
    const beforeNativeTabs = moveCalls();
    quick.focus();
    fireEvent.keyDown(quick, { key: "Tab" });
    expect(moveCalls()).toBe(beforeNativeTabs);
    const add = screen.getByRole("button", { name: "Add subtask to First" });
    fireEvent.keyDown(add, { key: "Tab" });
    expect(moveCalls()).toBe(beforeNativeTabs);
  });

  it("uses execution-time positions for exact LIFO undo after queued sibling moves", async () => {
    tasks = [
      task({ title: "First" }),
      task({ id: secondId, title: "Second", tags: [], position: 1 }),
      task({
        id: childId,
        title: "Third",
        tags: [],
        position: 2
      })
    ];
    let releaseFirstMove: (() => void) | undefined;
    const normalFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === `/api/tasks/${secondId}/move`) {
        await new Promise<void>(resolve => { releaseFirstMove = resolve; });
      }
      if (!normalFetch) throw new Error("Expected fetch implementation");
      return normalFetch(input, init);
    });

    render(<App/>);
    const tree = await screen.findByRole("tree");
    const secondRow = within(tree).getByText("Second").closest("[role=treeitem]");
    const thirdRow = within(tree).getByText("Third").closest("[role=treeitem]");
    fireEvent.keyDown(secondRow as HTMLElement, { key: "Tab" });
    fireEvent.keyDown(thirdRow as HTMLElement, { key: "Tab" });
    await waitFor(() => expect(releaseFirstMove).toBeTypeOf("function"));
    releaseFirstMove?.();
    await waitFor(() => {
      expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/move"))).toHaveLength(2);
    });

    fireEvent.click(screen.getByRole("button", { name: "Undo last action" }));
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        `/api/tasks/${childId}/move`,
        expect.objectContaining({
          body: JSON.stringify({ parentId: null, position: 1 })
        })
      );
    });
    await waitFor(() => {
      expect(within(screen.getByRole("tree")).getByText("Third").closest("[role=treeitem]"))
        .toHaveAttribute("aria-level", "1");
    });
  });

  it("preserves native text undo and uses Ctrl/Cmd+Z plus the visible action for global undo", async () => {
    const user = userEvent.setup();
    render(<App/>);
    await screen.findByText("Existing task");
    const quick = screen.getByRole("textbox", { name: "Quick entry" });
    await user.type(quick, "Undo me{Enter}");
    const undo = screen.getByRole("button", { name: "Undo last action" });
    expect(undo).toBeEnabled();

    await user.type(quick, "typing");
    fireEvent.keyDown(quick, { key: "z", ctrlKey: true });
    expect(fetchMock).not.toHaveBeenCalledWith(
      `/api/tasks/${createdId}`,
      expect.objectContaining({ method: "DELETE" })
    );

    fireEvent.keyDown(document.body, { key: "z", metaKey: true });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${createdId}`,
      expect.objectContaining({ method: "DELETE" })
    ));
    expect(undo).toBeDisabled();
    expect(screen.getByText(/Undid created task/i)).toBeVisible();
  });

  it("cancels a dirty editor when refresh removes its task during undo", async () => {
    const user = userEvent.setup();
    render(<App/>);
    await screen.findByText("Existing task");
    const quick = screen.getByRole("textbox", { name: "Quick entry" });
    await user.type(quick, "Temporary{Enter}");
    await user.click(await within(screen.getByRole("tree")).findByText("Temporary"));
    await user.type(screen.getByRole("textbox", { name: "Edit Temporary" }), " changed");

    await user.click(screen.getByRole("button", { name: "Undo last action" }));
    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Edit Temporary" })).not.toBeInTheDocument();
    });

    await user.click(within(screen.getByRole("tree")).getByText("Existing task"));
    expect(screen.getByRole("textbox", { name: "Edit Existing task" })).toBeVisible();
  });

  it("undoes completion, inspector edits, moves, and recursive deletion with exact inverse calls", async () => {
    const user = userEvent.setup();
    render(<App/>);
    await screen.findByText("Existing task");
    await user.click(screen.getByLabelText("Complete Existing task"));
    await user.click(screen.getByRole("button", { name: "Undo last action" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${rootId}/completion`,
      expect.objectContaining({ body: JSON.stringify({ completed: false }) })
    ));
    expect(await screen.findByLabelText("Complete Existing task")).toBeVisible();

    await user.click(await screen.findByText("Existing task"));
    fireEvent.change(screen.getByPlaceholderText("Add notes…"), { target: { value: "Details" } });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${rootId}`,
      expect.objectContaining({ body: JSON.stringify({ notes: "Details" }) })
    ));
    await user.click(screen.getByRole("button", { name: "Undo last action" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${rootId}`,
      expect.objectContaining({ body: JSON.stringify({ notes: "" }) })
    ));
    expect(screen.getByPlaceholderText("Add notes…")).toHaveValue("");

    const recurrence = screen.getByLabelText("Recurrence");
    fireEvent.change(recurrence, { target: { value: "monthly" } });
    fireEvent.blur(recurrence);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${rootId}`,
      expect.objectContaining({ body: JSON.stringify({ recurrence: "monthly" }) })
    ));
    await user.click(screen.getByRole("button", { name: "Undo last action" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      `/api/tasks/${rootId}`,
      expect.objectContaining({ body: JSON.stringify({ recurrence: null }) })
    ));
    expect(screen.getByLabelText("Recurrence")).toHaveValue("");

    await user.click(screen.getByRole("button", { name: "Delete task" }));
    expect(await screen.findByText("All clear")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Undo last action" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith(
      "/api/tasks/restore",
      expect.objectContaining({ method: "POST" })
    ));
    expect(await screen.findByText("Existing task")).toBeVisible();
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
