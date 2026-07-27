import { z } from "zod";

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

export const updateTaskSchema = z.object(taskFields).strict().refine(
  value => Object.keys(value).length > 0,
  { message: "At least one field is required" }
);

export const completionSchema = z.object({ completed: z.boolean() }).strict();
export const idParamsSchema = z.object({ id: z.uuid() }).strict();
