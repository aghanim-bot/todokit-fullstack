import type { ApiErrorBody, Task } from "../shared/types";

export interface DeletedTaskResult {
  deleted: number;
  subtree: Task;
}

export class ApiClientError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code: string
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init?.headers
    }
  });
  const body = await response.json() as { data: T } | ApiErrorBody;
  if (!response.ok) {
    const error = "error" in body ? body.error : undefined;
    throw new ApiClientError(error?.message ?? "Request failed", response.status, error?.code ?? "REQUEST_ERROR");
  }
  if (!("data" in body)) throw new ApiClientError("Malformed server response", response.status, "RESPONSE_ERROR");
  return body.data;
}

export const taskApi = {
  list: () => request<Task[]>("/api/tasks"),
  create: (input: Record<string, unknown>) => request<Task>("/api/tasks", {
    method: "POST",
    body: JSON.stringify(input)
  }),
  update: (id: string, patch: Record<string, unknown>) => request<Task>(`/api/tasks/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch)
  }),
  complete: (id: string, completed: boolean) => request<Task>(`/api/tasks/${id}/completion`, {
    method: "POST",
    body: JSON.stringify({ completed })
  }),
  move: (id: string, parentId: string | null, position: number) => request<Task>(`/api/tasks/${id}/move`, {
    method: "POST",
    body: JSON.stringify({ parentId, position })
  }),
  restore: (subtree: Task) => request<Task>("/api/tasks/restore", {
    method: "POST",
    body: JSON.stringify({ subtree })
  }),
  delete: (id: string) => request<DeletedTaskResult>(`/api/tasks/${id}`, {
    method: "DELETE"
  })
};
