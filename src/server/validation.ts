import { z } from "zod";
import { normalizeRecurrence } from "../shared/parser.js";
import type { Task } from "../shared/types.js";

const title = z.string().trim().min(1).max(500);
const notes = z.string().max(20_000);
const tag = z.string().trim().min(1).max(50).regex(/^[\p{L}\p{N}_-]+$/u, "Tags may contain letters, numbers, underscores, and hyphens");
const dueAt = z.string().refine(value => {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const date = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}, "Due date must be a real YYYY-MM-DD date or a canonical UTC ISO timestamp");

const taskFields = {
  parentId: z.uuid().nullable().optional(),
  title: title.optional(),
  notes: notes.optional(),
  dueAt: dueAt.nullable().optional(),
  reviewAt: dueAt.nullable().optional(),
  recurrence: z.string().trim().min(1).max(500).nullable().optional(),
  completed: z.boolean().optional(),
  flagged: z.boolean().optional(),
  tags: z.array(tag).max(20).optional()
};

export const createTaskSchema = z.object({
  ...taskFields,
  rawText: z.string().trim().min(1).max(1_000).optional()
}).strict().superRefine((value, context) => {
  if (!value.rawText && !value.title) {
    context.addIssue({ code: "custom", message: "Either rawText or title is required", path: ["title"] });
  }
  if (value.rawText && value.title) {
    context.addIssue({ code: "custom", message: "rawText and title cannot be supplied together", path: ["rawText"] });
  }
});

export const resolvedCreateTaskSchema = z.object({
  parentId: z.uuid().nullable().optional(),
  title,
  notes: notes.optional(),
  dueAt: dueAt.nullable().optional(),
  reviewAt: dueAt.nullable().optional(),
  recurrence: z.string().trim().min(1).max(500).nullable().optional(),
  completed: z.boolean().optional(),
  flagged: z.boolean().optional(),
  tags: z.array(tag).max(20).optional()
}).strict();

export const updateTaskSchema = z.object({
  ...taskFields,
  rawText: z.string().trim().min(1).max(1_000).optional()
}).strict().refine(
  value => Object.keys(value).length > 0,
  { message: "At least one field is required" }
).superRefine((value, context) => {
  if (value.rawText && Object.keys(value).length > 1) {
    context.addIssue({
      code: "custom",
      message: "rawText cannot be combined with structured fields",
      path: ["rawText"]
    });
  }
});

export const completionSchema = z.object({ completed: z.boolean() }).strict();
export const idParamsSchema = z.object({ id: z.uuid() }).strict();
export const moveTaskSchema = z.object({
  parentId: z.uuid().nullable(),
  position: z.number().int().nonnegative()
}).strict();

const timestamp = z.string().refine(value => {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}, "Timestamp must be a canonical ISO value");
const snapshotRecurrence = z.string().trim().min(1).max(500).refine(value => {
  try {
    return normalizeRecurrence(value) === value;
  } catch {
    return false;
  }
}, "Recurrence must be a canonical RRULE");

const taskSnapshotSchema: z.ZodType<Task> = z.lazy(() => z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  title,
  notes,
  dueAt: dueAt.nullable(),
  reviewAt: dueAt.nullable(),
  recurrence: snapshotRecurrence.nullable(),
  completed: z.boolean(),
  completedAt: timestamp.nullable(),
  flagged: z.boolean(),
  position: z.number().int().nonnegative(),
  createdAt: timestamp,
  updatedAt: timestamp,
  tags: z.array(tag).max(20),
  depth: z.number().int().nonnegative(),
  children: z.array(taskSnapshotSchema)
}).strict().superRefine((task, context) => {
  if (task.completed !== Boolean(task.completedAt)) {
    context.addIssue({
      code: "custom",
      message: "completedAt must be present exactly when the task is completed",
      path: ["completedAt"]
    });
  }
}));

export const restoreSubtreeSchema = z.object({
  subtree: taskSnapshotSchema
}).strict().superRefine(({ subtree }, context) => {
  const ids = new Set<string>();
  const visit = (
    task: Task,
    expectedParentId: string | null,
    expectedDepth: number,
    path: Array<string | number>
  ) => {
    if (ids.has(task.id)) {
      context.addIssue({
        code: "custom",
        message: "Task IDs must be unique within a subtree",
        path: [...path, "id"]
      });
    }
    ids.add(task.id);
    if (task.parentId !== expectedParentId) {
      context.addIssue({
        code: "custom",
        message: "Child parentId must match its containing task",
        path: [...path, "parentId"]
      });
    }
    if (task.depth !== expectedDepth) {
      context.addIssue({
        code: "custom",
        message: "Task depth must match its position in the subtree",
        path: [...path, "depth"]
      });
    }
    task.children.forEach((child, position) => {
      const childPath = [...path, "children", position];
      if (child.position !== position) {
        context.addIssue({
          code: "custom",
          message: "Child positions must be contiguous and match their array order",
          path: [...childPath, "position"]
        });
      }
      visit(child, task.id, expectedDepth + 1, childPath);
    });
  };

  visit(subtree, subtree.parentId, 0, ["subtree"]);
});
