export interface Task {
  id: string;
  parentId: string | null;
  title: string;
  notes: string;
  dueAt: string | null;
  reviewAt: string | null;
  recurrence: string | null;
  completed: boolean;
  completedAt: string | null;
  flagged: boolean;
  position: number;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  depth: number;
  children: Task[];
}

export interface ParsedInboxInput {
  title: string;
  dueAt: string | null;
  recurrence: string | null;
  tags: string[];
  warnings: string[];
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
