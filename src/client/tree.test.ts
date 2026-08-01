import { describe, expect, it } from "vitest";
import type { Task } from "../shared/types";
import { indentMove, outdentMove, previousSibling, siblingMove } from "./tree";

function task(id: string, children: Task[] = []): Task {
  return {
    id,
    parentId: null,
    title: id,
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
    tags: [],
    depth: 0,
    children
  };
}

describe("outline move helpers", () => {
  it("finds only the previous structural sibling and indents beneath it at the end", () => {
    const first = task("first", [task("existing-child")]);
    const second = task("second");
    const nested = task("nested");
    nested.parentId = "second";
    second.children = [nested];
    const tasks = [first, second];

    expect(previousSibling(tasks, "second")?.id).toBe("first");
    expect(previousSibling(tasks, "nested")).toBeUndefined();
    expect(indentMove(tasks, "second")).toEqual({
      parentId: "first",
      position: 1
    });
  });

  it("prevents root/no-previous-sibling no-ops and outdents immediately after its parent", () => {
    const first = task("first");
    const child = task("child");
    const grandchild = task("grandchild");
    child.parentId = "first";
    grandchild.parentId = "child";
    child.children = [grandchild];
    first.children = [child];
    const second = task("second");
    second.position = 1;
    const tasks = [first, second];

    expect(indentMove(tasks, "first")).toBeNull();
    expect(indentMove(tasks, "child")).toBeNull();
    expect(outdentMove(tasks, "first")).toBeNull();
    expect(outdentMove(tasks, "child")).toEqual({ parentId: null, position: 1 });
    expect(outdentMove(tasks, "grandchild")).toEqual({ parentId: "first", position: 1 });
  });

  it("moves among the full sibling list and rejects sibling boundaries", () => {
    const hidden = task("hidden");
    hidden.completed = true;
    hidden.position = 1;
    const first = task("first");
    const last = task("last");
    last.position = 2;
    const childFirst = task("child-first");
    const childLast = task("child-last");
    childFirst.parentId = "first";
    childLast.parentId = "first";
    childLast.position = 1;
    first.children = [childFirst, childLast];
    const tasks = [first, hidden, last];

    expect(siblingMove(tasks, "first", -1)).toBeNull();
    expect(siblingMove(tasks, "first", 1)).toEqual({ parentId: null, position: 1 });
    expect(siblingMove(tasks, "last", -1)).toEqual({ parentId: null, position: 1 });
    expect(siblingMove(tasks, "last", 1)).toBeNull();
    expect(siblingMove(tasks, "child-last", -1)).toEqual({ parentId: "first", position: 0 });
    expect(siblingMove(tasks, "child-first", 1)).toEqual({ parentId: "first", position: 1 });
  });
});
