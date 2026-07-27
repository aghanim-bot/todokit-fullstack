import fastifyStatic from "@fastify/static";
import type Database from "better-sqlite3";
import Fastify, { type FastifyInstance } from "fastify";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ZodError } from "zod";
import { normalizeRecurrence, parseInboxInput } from "../shared/parser.js";
import type { ApiErrorBody } from "../shared/types.js";
import { AppError } from "./errors.js";
import { TaskRepository, type CreateTaskInput, type UpdateTaskInput } from "./task-repository.js";
import {
  completionSchema,
  createTaskSchema,
  idParamsSchema,
  moveTaskSchema,
  resolvedCreateTaskSchema,
  restoreSubtreeSchema,
  updateTaskSchema
} from "./validation.js";

export interface AppOptions {
  logger?: boolean;
  staticDir?: string | false;
}

function validationError(error: ZodError): ApiErrorBody {
  return {
    error: {
      code: "VALIDATION_ERROR",
      message: "Request validation failed",
      details: error.issues.map(issue => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    }
  };
}

export async function createApp(db: Database.Database, options: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 64 * 1024
  });
  const repository = new TaskRepository(db);

  app.get("/health", async () => {
    db.prepare("SELECT 1").get();
    return { status: "ok" as const };
  });

  app.get("/api/tasks", async () => ({ data: repository.listTree() }));

  app.post("/api/tasks/restore", async (request, reply) => {
    const { subtree } = restoreSubtreeSchema.parse(request.body);
    return reply.code(201).send({ data: repository.restoreSubtree(subtree) });
  });

  app.get("/api/tasks/:id", async request => {
    const { id } = idParamsSchema.parse(request.params);
    return { data: repository.get(id) };
  });

  app.post("/api/tasks", async (request, reply) => {
    const body = createTaskSchema.parse(request.body);
    let input: CreateTaskInput;
    if (body.rawText) {
      const parsed = parseInboxInput(body.rawText);
      if (parsed.warnings.length) {
        throw new AppError(422, "PARSE_ERROR", "Inbox text contains an invalid date or recurrence", {
          warnings: parsed.warnings
        });
      }
      if (!parsed.title) {
        throw new AppError(422, "PARSE_ERROR", "Inbox text must include a task title");
      }
      input = {
        parentId: body.parentId,
        title: parsed.title,
        notes: body.notes,
        dueAt: body.dueAt !== undefined ? body.dueAt : parsed.dueAt,
        recurrence: body.recurrence !== undefined ? body.recurrence : parsed.recurrence,
        completed: body.completed,
        flagged: body.flagged,
        tags: body.tags ?? parsed.tags
      };
    } else {
      input = body as CreateTaskInput;
    }
    if (input.recurrence) {
      try {
        input.recurrence = normalizeRecurrence(input.recurrence);
      } catch {
        throw new AppError(422, "VALIDATION_ERROR", "Invalid recurrence rule", {
          recurrence: "Use a supported natural interval or one RFC 5545 RRULE"
        });
      }
    }
    input = resolvedCreateTaskSchema.parse(input);
    const task = repository.create(input);
    return reply.code(201).send({ data: task });
  });

  app.patch("/api/tasks/:id", async request => {
    const { id } = idParamsSchema.parse(request.params);
    const body = updateTaskSchema.parse(request.body);
    let patch: UpdateTaskInput;
    if (body.rawText) {
      const parsed = parseInboxInput(body.rawText);
      if (parsed.warnings.length) {
        throw new AppError(422, "PARSE_ERROR", "Task text contains an invalid date or recurrence", {
          warnings: parsed.warnings
        });
      }
      if (!parsed.title) {
        throw new AppError(422, "PARSE_ERROR", "Task text must include a task title");
      }
      patch = {
        title: parsed.title,
        dueAt: parsed.dueAt,
        recurrence: parsed.recurrence,
        tags: parsed.tags
      };
    } else {
      patch = body as UpdateTaskInput;
    }
    if (patch.recurrence) {
      try {
        patch.recurrence = normalizeRecurrence(patch.recurrence);
      } catch {
        throw new AppError(422, "VALIDATION_ERROR", "Invalid recurrence rule");
      }
    }
    return { data: repository.update(id, patch) };
  });

  app.post("/api/tasks/:id/completion", async request => {
    const { id } = idParamsSchema.parse(request.params);
    const { completed } = completionSchema.parse(request.body);
    return { data: repository.setCompleted(id, completed) };
  });

  app.post("/api/tasks/:id/move", async request => {
    const { id } = idParamsSchema.parse(request.params);
    const move = moveTaskSchema.parse(request.body);
    return { data: repository.move(id, move) };
  });

  app.delete("/api/tasks/:id", async request => {
    const { id } = idParamsSchema.parse(request.params);
    return { data: repository.deleteSubtree(id) };
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send(validationError(error));
    }
    if (error instanceof AppError) {
      return reply.code(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          ...(error.details !== undefined ? { details: error.details } : {})
        }
      });
    }
    const httpError = error as { statusCode?: number; code?: string; message?: string };
    if (httpError.statusCode && httpError.statusCode >= 400 && httpError.statusCode < 500) {
      return reply.code(httpError.statusCode).send({
        error: {
          code: httpError.statusCode === 413 ? "PAYLOAD_TOO_LARGE" : "INVALID_REQUEST",
          message: httpError.statusCode === 413 ? "Request body is too large" : "Request could not be parsed"
        }
      });
    }
    app.log.error(error);
    return reply.code(500).send({
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred"
      }
    });
  });

  const staticDir = options.staticDir === undefined ? resolve("dist/client") : options.staticDir;
  if (staticDir && existsSync(staticDir)) {
    await app.register(fastifyStatic, {
      root: staticDir,
      wildcard: false
    });
  }

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/") || request.url === "/health" || !staticDir || !existsSync(staticDir)) {
      return reply.code(404).send({
        error: {
          code: "NOT_FOUND",
          message: "Route not found"
        }
      });
    }
    return reply.type("text/html").sendFile("index.html");
  });

  return app;
}
