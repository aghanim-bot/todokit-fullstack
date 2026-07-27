import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  PerspectiveRail,
  ProjectNavigator,
  QuickEntry,
  TaskInspector,
  TaskOutline,
  TodoKitLayout,
  type PerspectiveRailItem,
  type ProjectNavigatorItem,
  type TaskInspectorViewModel,
  type TaskViewModel
} from "todokit";
import { parseInboxInput } from "../shared/parser";
import type { Task } from "../shared/types";
import { taskApi } from "./api";

type Perspective = "inbox" | "forecast" | "flagged" | "completed";

const perspectiveDefinitions: Array<{ id: Perspective; label: string; icon: string }> = [
  { id: "inbox", label: "Inbox", icon: "inbox" },
  { id: "forecast", label: "Upcoming", icon: "forecast" },
  { id: "flagged", label: "Flagged", icon: "flagged" },
  { id: "completed", label: "Completed", icon: "review" }
];

function flatten(tasks: Task[]): Task[] {
  return tasks.flatMap(task => [task, ...flatten(task.children)]);
}

function findTask(tasks: Task[], id: string | null): Task | undefined {
  if (!id) return undefined;
  for (const task of tasks) {
    if (task.id === id) return task;
    const match = findTask(task.children, id);
    if (match) return match;
  }
}

function filterTree(tasks: Task[], predicate: (task: Task) => boolean): Task[] {
  return tasks.flatMap(task => {
    const children = filterTree(task.children, predicate);
    return predicate(task) || children.length ? [{ ...task, children }] : [];
  });
}

function replaceTask(tasks: Task[], id: string, transform: (task: Task) => Task): Task[] {
  return tasks.map(task => task.id === id
    ? transform(task)
    : { ...task, children: replaceTask(task.children, id, transform) });
}

function datePart(value: string | null): string {
  return value?.slice(0, 10) ?? "";
}

function isOverdue(task: Task, today: string): boolean {
  return !task.completed && Boolean(task.dueAt) && datePart(task.dueAt) < today;
}

function taskView(task: Task, expanded: Set<string>, today: string): TaskViewModel {
  return {
    id: task.id,
    title: task.title,
    completed: task.completed,
    expanded: expanded.has(task.id),
    flagged: task.flagged,
    tags: task.tags,
    dueDate: datePart(task.dueAt),
    reviewDate: datePart(task.reviewAt),
    dueDateStatus: isOverdue(task, today) ? "overdue" : "default",
    children: task.children.map(child => taskView(child, expanded, today))
  };
}

function inspectorView(task: Task): TaskInspectorViewModel {
  return {
    id: task.id,
    title: task.title,
    notes: task.notes,
    dueDate: datePart(task.dueAt),
    reviewDate: datePart(task.reviewAt),
    tags: task.tags,
    flagged: task.flagged
  };
}

function recurrenceLabel(rule: string | null): string {
  if (!rule) return "";
  const labels: Record<string, string> = {
    "RRULE:FREQ=DAILY": "daily",
    "RRULE:FREQ=WEEKLY": "weekly",
    "RRULE:FREQ=MONTHLY": "monthly",
    "RRULE:FREQ=YEARLY": "yearly",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR": "every weekday"
  };
  return labels[rule] ?? rule;
}

interface DetailsProps {
  task?: Task;
  onChange: (patch: Partial<TaskInspectorViewModel>) => void;
  onRecurrenceChange: (value: string | null) => void;
  onDelete: () => void;
  onClose: () => void;
}

function Details({ task, onChange, onRecurrenceChange, onDelete, onClose }: DetailsProps) {
  const [recurrence, setRecurrence] = useState(recurrenceLabel(task?.recurrence ?? null));
  return <div className={`app-inspector ${task ? "has-task" : ""}`}>
    {task && <button className="app-inspector-close" type="button" onClick={onClose}>Close details</button>}
    <TaskInspector task={task ? inspectorView(task) : undefined} onChange={onChange} onDelete={onDelete}/>
    {task && <section className="app-recurrence">
      <label htmlFor="recurrence">Recurrence</label>
      <input
        id="recurrence"
        value={recurrence}
        placeholder="monthly or RRULE:FREQ=MONTHLY"
        onChange={event => setRecurrence(event.target.value)}
        onBlur={() => onRecurrenceChange(recurrence.trim() || null)}
      />
      <small>Natural intervals or a canonical RFC 5545 RRULE</small>
    </section>}
  </div>;
}

export function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [quickText, setQuickText] = useState("");
  const [perspective, setPerspective] = useState<Perspective>("inbox");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const saveChains = useRef(new Map<string, Promise<unknown>>());

  const refresh = useCallback(async () => {
    try {
      const next = await taskApi.list();
      setTasks(next);
      setExpanded(current => {
        if (current.size) return current;
        return new Set(flatten(next).map(task => task.id));
      });
      setSelectedId(current => current && findTask(next, current) ? current : null);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to load tasks");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void Promise.resolve().then(refresh);
  }, [refresh]);

  const allTasks = useMemo(() => flatten(tasks), [tasks]);
  const selected = findTask(tasks, selectedId);
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const future = new Date(now);
  future.setUTCDate(future.getUTCDate() + 7);
  const forecastEnd = future.toISOString().slice(0, 10);

  const predicate = useCallback((task: Task) => {
    if (activeTag) return task.tags.includes(activeTag) && !task.completed;
    if (perspective === "completed") return task.completed;
    if (perspective === "flagged") return task.flagged && !task.completed;
    if (perspective === "forecast") {
      const due = datePart(task.dueAt);
      return !task.completed && Boolean(due) && due >= today && due <= forecastEnd;
    }
    return !task.completed;
  }, [activeTag, perspective, today, forecastEnd]);

  const visibleTasks = useMemo(() => filterTree(tasks, predicate), [tasks, predicate]);
  const counts = {
    inbox: allTasks.filter(task => !task.completed).length,
    forecast: allTasks.filter(task => {
      const due = datePart(task.dueAt);
      return !task.completed && Boolean(due) && due >= today && due <= forecastEnd;
    }).length,
    flagged: allTasks.filter(task => task.flagged && !task.completed).length,
    completed: allTasks.filter(task => task.completed).length
  };
  const railItems: PerspectiveRailItem[] = perspectiveDefinitions.map(item => ({ ...item, count: counts[item.id] }));
  const tagCounts = new Map<string, number>();
  for (const task of allTasks) {
    if (!task.completed) for (const tag of task.tags) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
  }
  const tagItems: ProjectNavigatorItem[] = [...tagCounts].sort(([left], [right]) => left.localeCompare(right))
    .map(([tag, count], index) => ({
      id: tag,
      label: `#${tag}`,
      count,
      color: ["#8580e8", "#6e9fe3", "#72b69b", "#c6a267"][index % 4]
    }));

  const run = useCallback(async (operation: () => Promise<unknown>) => {
    try {
      await operation();
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Request failed");
      await refresh();
    }
  }, [refresh]);

  const savePatch = useCallback((id: string, patch: Record<string, unknown>, optimistic: (task: Task) => Task) => {
    setTasks(current => replaceTask(current, id, optimistic));
    const previous = saveChains.current.get(id) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(() => taskApi.update(id, patch));
    saveChains.current.set(id, next);
    void next.then(() => setError(null)).catch(async cause => {
      setError(cause instanceof Error ? cause.message : "Could not save task");
      await refresh();
    }).finally(() => {
      if (saveChains.current.get(id) === next) saveChains.current.delete(id);
    });
  }, [refresh]);

  const inspectorChange = (patch: Partial<TaskInspectorViewModel>) => {
    if (!selected) return;
    if (patch.title !== undefined && !patch.title.trim()) return;
    const apiPatch: Record<string, unknown> = {};
    if (patch.title !== undefined) apiPatch.title = patch.title;
    if (patch.notes !== undefined) apiPatch.notes = patch.notes;
    if (patch.dueDate !== undefined) apiPatch.dueAt = patch.dueDate || null;
    if (patch.reviewDate !== undefined) apiPatch.reviewAt = patch.reviewDate || null;
    if (patch.tags !== undefined) apiPatch.tags = patch.tags;
    if (patch.flagged !== undefined) apiPatch.flagged = patch.flagged;
    savePatch(selected.id, apiPatch, task => ({
      ...task,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
      ...(patch.dueDate !== undefined ? { dueAt: patch.dueDate || null } : {}),
      ...(patch.reviewDate !== undefined ? { reviewAt: patch.reviewDate || null } : {}),
      ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
      ...(patch.flagged !== undefined ? { flagged: patch.flagged } : {})
    }));
  };

  if (loading) return <main className="app-state" aria-live="polite"><span className="app-spinner"/><h1>Loading tasks</h1></main>;

  const viewTitle = activeTag
    ? `#${activeTag}`
    : perspectiveDefinitions.find(item => item.id === perspective)?.label ?? "Inbox";
  const parsedPreview = quickText ? parseInboxInput(quickText) : null;

  return <TodoKitLayout
    className="app-shell"
    rail={<PerspectiveRail
      activeId={activeTag ? "" : perspective}
      items={railItems}
      onSelect={id => {
        setPerspective(id as Perspective);
        setActiveTag(null);
        setSelectedId(null);
      }}
    />}
    navigator={<ProjectNavigator
      title="Tags"
      items={tagItems}
      activeId={activeTag}
      onSelect={tag => {
        setActiveTag(tag);
        setSelectedId(null);
      }}
      footer={<span><i/>{error ? "Sync interrupted" : "Synced with server"}</span>}
    />}
    main={<>
      {error && <div className="app-error" role="alert"><span>{error}</span><button type="button" onClick={() => void refresh()}>Retry</button></div>}
      <QuickEntry
        value={quickText}
        onValueChange={setQuickText}
        onSubmit={rawText => {
          if (!rawText.trim()) return;
          void run(async () => {
            await taskApi.create({ rawText });
            setQuickText("");
            await refresh();
          });
        }}
        placeholder={'Try “Submit report tomorrow at 5pm #work”'}
        helpText={parsedPreview
          ? <>
            {parsedPreview.tags.map(tag => <span className="tk-chip" key={tag}>#{tag}</span>)}
            {parsedPreview.dueAt && <span className="tk-date-chip">Due {datePart(parsedPreview.dueAt)}</span>}
            {parsedPreview.recurrence && <span className="tk-date-chip">{recurrenceLabel(parsedPreview.recurrence)}</span>}
            {parsedPreview.warnings.length > 0 && <span className="app-warning">Check date or recurrence</span>}
          </>
          : "#tags · tomorrow at 5pm · monthly · due 2026-08-01"}
      />
      <TaskOutline
        tasks={visibleTasks.map(task => taskView(task, expanded, today))}
        title={viewTitle}
        headerEyebrow={activeTag ? "Tag" : "Perspective"}
        headerSummary={`${flatten(visibleTasks).filter(task => !task.completed).length} remaining`}
        selectedTaskId={selectedId}
        onSelect={setSelectedId}
        onToggleExpanded={id => setExpanded(current => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        })}
        onToggleComplete={id => {
          const task = findTask(tasks, id);
          if (!task) return;
          void run(async () => {
            await taskApi.complete(id, !task.completed);
            await refresh();
          });
        }}
        onAddSubtask={parentId => {
          const rawText = window.prompt("Subtask title (dates, recurrence, and #tags are supported)");
          if (!rawText?.trim()) return;
          void run(async () => {
            await taskApi.create({ rawText, parentId });
            setExpanded(current => new Set(current).add(parentId));
            await refresh();
          });
        }}
      />
    </>}
    inspector={<Details
      key={selected?.id ?? "empty"}
      task={selected}
      onChange={inspectorChange}
      onClose={() => setSelectedId(null)}
      onRecurrenceChange={recurrence => {
        if (!selected || recurrenceLabel(selected.recurrence) === (recurrence ?? "")) return;
        savePatch(selected.id, { recurrence }, task => ({ ...task, recurrence }));
      }}
      onDelete={() => {
        if (!selected || !window.confirm(`Delete “${selected.title}” and all of its subtasks?`)) return;
        void run(async () => {
          await taskApi.delete(selected.id);
          setSelectedId(null);
          await refresh();
        });
      }}
    />}
  />;
}
