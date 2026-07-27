import type { Task } from "../shared/types";

export interface TreeMove {
  parentId: string | null;
  position: number;
}

interface TaskLocation {
  task: Task;
  parent: Task | null;
  siblings: Task[];
  index: number;
}

function findLocation(tasks: Task[], id: string, parent: Task | null = null): TaskLocation | undefined {
  const index = tasks.findIndex(task => task.id === id);
  if (index >= 0) {
    const task = tasks[index];
    return task ? { task, parent, siblings: tasks, index } : undefined;
  }
  for (const task of tasks) {
    const location = findLocation(task.children, id, task);
    if (location) return location;
  }
}

export function previousSibling(tasks: Task[], id: string): Task | undefined {
  const location = findLocation(tasks, id);
  return location && location.index > 0 ? location.siblings[location.index - 1] : undefined;
}

export function indentMove(tasks: Task[], id: string): TreeMove | null {
  const sibling = previousSibling(tasks, id);
  if (!sibling) return null;
  return {
    parentId: sibling.id,
    position: sibling.children.length
  };
}

export function outdentMove(tasks: Task[], id: string): TreeMove | null {
  const location = findLocation(tasks, id);
  if (!location?.parent) return null;
  return {
    parentId: location.parent.parentId,
    position: location.parent.position + 1
  };
}
