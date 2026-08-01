import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from "react";
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
import {
  inboxHighlightRanges,
  parseInboxInput,
  taskToEditableRawText
} from "../shared/parser";
import type { Task } from "../shared/types";
import { taskApi } from "./api";
import { indentMove, outdentMove, siblingMove, type TreeMove } from "./tree";

type Perspective = "inbox" | "forecast" | "flagged" | "completed";

const DRAFT_ID = "__local-subtask-draft__";
const perspectiveDefinitions: Array<{ id: Perspective; label: string; icon: string }> = [
  { id: "inbox", label: "Inbox", icon: "inbox" },
  { id: "forecast", label: "Upcoming", icon: "forecast" },
  { id: "flagged", label: "Flagged", icon: "flagged" },
  { id: "completed", label: "Completed", icon: "review" }
];

interface ExistingEditor {
  kind: "existing";
  taskId: string;
  originalRaw: string;
  value: string;
}

interface DraftEditor {
  kind: "draft";
  parentId: string;
  parentTitle: string;
  value: string;
}

type ActiveEditor = ExistingEditor | DraftEditor;

interface UndoEntry {
  id: number;
  label: string;
  inverse: () => Promise<unknown>;
}

function flatten(tasks: Task[]): Task[] {
  return tasks.flatMap(task => [task, ...flatten(task.children)]);
}

function renderedRowIds(tasks: Task[], expanded: Set<string>, editor: ActiveEditor | null): string[] {
  return tasks.flatMap(task => [
    task.id,
    ...(expanded.has(task.id) ? renderedRowIds(task.children, expanded, editor) : []),
    ...(expanded.has(task.id) && editor?.kind === "draft" && editor.parentId === task.id ? [DRAFT_ID] : [])
  ]);
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

function withEffectiveCompletion(tasks: Task[], ancestorCompleted = false): Task[] {
  return tasks.map(task => {
    const completed = ancestorCompleted || task.completed;
    return {
      ...task,
      completed,
      children: withEffectiveCompletion(task.children, completed)
    };
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

function taskView(task: Task, expanded: Set<string>, today: string, editor: ActiveEditor | null): TaskViewModel {
  const children = task.children.map(child => taskView(child, expanded, today, editor));
  if (editor?.kind === "draft" && editor.parentId === task.id) {
    children.push({
      id: DRAFT_ID,
      title: "New subtask",
      completed: false,
      expanded: false,
      children: []
    });
  }
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
    children
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

function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(
    "input, textarea, select, [contenteditable]:not([contenteditable=false]), [role=textbox], [role=searchbox], [role=combobox], [role=spinbutton]"
  ));
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
  const tasksRef = useRef<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("No actions to undo");
  const [quickText, setQuickText] = useState("");
  const [perspective, setPerspective] = useState<Perspective>("inbox");
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<ActiveEditor | null>(null);
  const editorRef = useRef<HTMLInputElement | null>(null);
  const [undoHistory, setUndoHistory] = useState<UndoEntry[]>([]);
  const undoHistoryRef = useRef<UndoEntry[]>([]);
  const nextUndoId = useRef(1);
  const mutationChain = useRef<Promise<void>>(Promise.resolve());
  const editorSavePending = useRef(false);
  const quickSavePending = useRef(false);
  const pendingMoves = useRef(new Set<string>());
  const pendingCompletions = useRef(new Set<string>());
  const pendingDeletes = useRef(new Set<string>());
  const editorIdentity = editor
    ? `${editor.kind}:${editor.kind === "existing" ? editor.taskId : editor.parentId}`
    : "";

  const replaceTasks = useCallback((next: Task[]) => {
    tasksRef.current = next;
    setTasks(next);
  }, []);

  const refresh = useCallback(async () => {
    const next = await taskApi.list();
    replaceTasks(next);
    setExpanded(current => {
      if (current.size) return current;
      return new Set(flatten(next).map(task => task.id));
    });
    setSelectedId(current => current && findTask(next, current) ? current : null);
    setEditor(current => {
      if (!current) return null;
      if (current.kind === "draft") {
        const parent = findTask(next, current.parentId);
        return parent ? { ...current, parentTitle: parent.title } : null;
      }
      const task = findTask(next, current.taskId);
      if (!task) return null;
      if (current.value !== current.originalRaw) return current;
      const raw = taskToEditableRawText(task);
      return { ...current, originalRaw: raw, value: raw };
    });
    setError(null);
    return next;
  }, [replaceTasks]);

  useEffect(() => {
    void Promise.resolve()
      .then(refresh)
      .catch(cause => setError(cause instanceof Error ? cause.message : "Unable to load tasks"))
      .finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    if (!editorIdentity) return;
    const frame = requestAnimationFrame(() => {
      editorRef.current?.focus();
      const end = editorRef.current?.value.length ?? 0;
      editorRef.current?.setSelectionRange(end, end);
    });
    return () => cancelAnimationFrame(frame);
  }, [editorIdentity]);

  const serialize = useCallback(<T,>(operation: () => Promise<T>): Promise<T> => {
    const result = mutationChain.current.then(operation, operation);
    mutationChain.current = result.then(() => undefined, () => undefined);
    return result;
  }, []);

  const setHistory = useCallback((next: UndoEntry[]) => {
    undoHistoryRef.current = next;
    setUndoHistory(next);
  }, []);

  const pushUndo = useCallback((label: string, inverse: () => Promise<unknown>) => {
    const next = [
      ...undoHistoryRef.current,
      { id: nextUndoId.current++, label, inverse }
    ].slice(-100);
    setHistory(next);
  }, [setHistory]);

  const performMutation = useCallback(<T,>(
    label: string,
    forward: () => Promise<T>,
    inverseFor: (result: T) => () => Promise<unknown>
  ): Promise<T | undefined> => serialize(async () => {
    let result: T;
    try {
      result = await forward();
    } catch (cause) {
      setHistory([]);
      setStatus("Undo history cleared after a failed change");
      setError(cause instanceof Error ? cause.message : "Request failed");
      try {
        await refresh();
      } catch {
        // The original actionable error remains visible.
      }
      return undefined;
    }
    pushUndo(label, inverseFor(result));
    setStatus(label);
    try {
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Change saved, but refresh failed");
    }
    return result;
  }), [pushUndo, refresh, serialize, setHistory]);

  const undo = useCallback(() => {
    void serialize(async () => {
      const entry = undoHistoryRef.current.at(-1);
      if (!entry) return;
      try {
        await entry.inverse();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Could not undo");
        setStatus(`Could not undo ${entry.label.toLocaleLowerCase("en-US")}`);
        try {
          await refresh();
        } catch {
          // Preserve the failed entry so the exact inverse can be retried.
        }
        return;
      }
      setHistory(undoHistoryRef.current.filter(candidate => candidate.id !== entry.id));
      setStatus(`Undid ${entry.label.toLocaleLowerCase("en-US")}`);
      try {
        await refresh();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Undo succeeded, but refresh failed");
      }
    });
  }, [refresh, serialize, setHistory]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLocaleLowerCase("en-US") === "n"
        && !event.ctrlKey
        && !event.metaKey
        && !event.altKey
        && !event.shiftKey
        && !event.repeat
        && !isTextEditingTarget(event.target)
      ) {
        event.preventDefault();
        document.querySelector<HTMLInputElement>('input[aria-label="Quick entry"]')?.focus();
        return;
      }
      if (
        event.key.toLocaleLowerCase("en-US") !== "z"
        || (!event.ctrlKey && !event.metaKey)
        || event.altKey
        || event.shiftKey
        || event.repeat
        || isTextEditingTarget(event.target)
      ) return;
      event.preventDefault();
      undo();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [undo]);

  const focusSelectedRow = useCallback(() => {
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>('[role="treeitem"][aria-selected="true"]');
      row?.focus();
    });
  }, []);

  const cancelEditor = useCallback((restoreFocus = true) => {
    setEditor(null);
    setStatus("Edit cancelled");
    if (restoreFocus) focusSelectedRow();
  }, [focusSelectedRow]);

  const canReplaceEditor = useCallback(() => {
    if (!editor) return true;
    const unchanged = editor.kind === "existing" && editor.value === editor.originalRaw;
    if (!editor.value.trim() || unchanged) return true;
    setStatus("Save with Enter or cancel with Escape before switching tasks");
    return false;
  }, [editor]);

  const openExistingEditor = useCallback((id: string) => {
    if (editor?.kind === "existing" && editor.taskId === id) return;
    if (!canReplaceEditor()) return;
    const task = findTask(tasksRef.current, id);
    if (!task) return;
    const raw = taskToEditableRawText(task);
    setSelectedId(id);
    setEditor({ kind: "existing", taskId: id, originalRaw: raw, value: raw });
    setStatus(`Editing ${task.title}`);
  }, [canReplaceEditor, editor]);

  const openDraftEditor = useCallback((parentId: string) => {
    if (!canReplaceEditor()) return;
    const parent = findTask(tasksRef.current, parentId);
    if (!parent) return;
    setSelectedId(parentId);
    setExpanded(current => new Set(current).add(parentId));
    setEditor({ kind: "draft", parentId, parentTitle: parent.title, value: "" });
    setStatus(`New subtask for ${parent.title}`);
  }, [canReplaceEditor]);

  const commitEditor = useCallback(async (createNextDraft = false) => {
    if (editorSavePending.current) return;
    const current = editor;
    if (!current) return;
    const parsed = parseInboxInput(current.value);
    if (!current.value.trim() || !parsed.title) {
      cancelEditor();
      return;
    }
    if (parsed.warnings.length) {
      setStatus("Fix the highlighted date or recurrence before saving");
      return;
    }

    editorSavePending.current = true;
    try {
      if (current.kind === "draft") {
        const created = await performMutation(
          "Created subtask",
          () => taskApi.create({ rawText: current.value, parentId: current.parentId }),
          task => () => taskApi.delete(task.id)
        );
        if (!created) return;
        setEditor(null);
        setSelectedId(created.id);
        focusSelectedRow();
        return;
      }

      const previous = findTask(tasksRef.current, current.taskId);
      if (!previous) {
        cancelEditor(false);
        return;
      }
      const previousFields = {
        title: previous.title,
        dueAt: previous.dueAt,
        recurrence: previous.recurrence,
        tags: previous.tags
      };
      const updated = await performMutation(
        "Edited task",
        () => taskApi.update(current.taskId, { rawText: current.value }),
        () => () => taskApi.update(current.taskId, previousFields)
      );
      if (!updated) return;
      setSelectedId(current.taskId);
      if (createNextDraft) {
        setExpanded(value => new Set(value).add(current.taskId));
        setEditor({
          kind: "draft",
          parentId: current.taskId,
          parentTitle: updated.title,
          value: ""
        });
      } else {
        setEditor(null);
        focusSelectedRow();
      }
    } finally {
      editorSavePending.current = false;
    }
  }, [cancelEditor, editor, focusSelectedRow, performMutation]);

  const effectiveTasks = useMemo(() => withEffectiveCompletion(tasks), [tasks]);
  const allTasks = useMemo(() => flatten(effectiveTasks), [effectiveTasks]);
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

  const visibleTasks = useMemo(() => filterTree(effectiveTasks, predicate), [effectiveTasks, predicate]);
  const visibleRowIds = useMemo(
    () => renderedRowIds(visibleTasks, expanded, editor),
    [editor, expanded, visibleTasks]
  );
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

  const patchTask = useCallback((id: string, patch: Record<string, unknown>, label: string) => {
    const previous = findTask(tasksRef.current, id);
    if (!previous) return;
    const inversePatch: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) {
      inversePatch[key] = previous[key as keyof Task];
    }
    const optimistic = replaceTask(tasksRef.current, id, task => ({ ...task, ...patch }));
    replaceTasks(optimistic);
    void performMutation(
      label,
      () => taskApi.update(id, patch),
      () => () => taskApi.update(id, inversePatch)
    );
  }, [performMutation, replaceTasks]);

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
    patchTask(selected.id, apiPatch, "Edited task details");
  };

  const moveTask = useCallback((
    id: string,
    move: TreeMove | null,
    restoreRowFocus = true,
    label?: string
  ) => {
    if (pendingMoves.current.has(id)) return;
    const previous = findTask(tasksRef.current, id);
    if (!previous || !move) {
      setStatus("That outline move is not available");
      return;
    }
    if (previous.parentId === move.parentId && previous.position === move.position) return;
    let inverseMove = { parentId: previous.parentId, position: previous.position };
    pendingMoves.current.add(id);
    void performMutation(
      label ?? (move.parentId === previous.parentId || move.parentId ? "Indented task" : "Outdented task"),
      () => {
        const current = findTask(tasksRef.current, id);
        if (!current) throw new Error("Task is no longer available to move");
        inverseMove = { parentId: current.parentId, position: current.position };
        return taskApi.move(id, move.parentId, move.position);
      },
      () => () => taskApi.move(id, inverseMove.parentId, inverseMove.position)
    ).then(result => {
      if (!result) return;
      if (move.parentId) setExpanded(current => new Set(current).add(move.parentId as string));
      setSelectedId(id);
      if (restoreRowFocus) focusSelectedRow();
    }).finally(() => {
      pendingMoves.current.delete(id);
    });
  }, [focusSelectedRow, performMutation]);

  useEffect(() => {
    const onReorderKeyDown = (event: KeyboardEvent) => {
      if (
        !event.altKey
        || event.ctrlKey
        || event.metaKey
        || event.shiftKey
        || event.repeat
        || (event.key !== "ArrowUp" && event.key !== "ArrowDown")
        || isTextEditingTarget(event.target)
      ) return;
      const row = event.target instanceof Element
        ? event.target.closest<HTMLElement>('[role="treeitem"]')
        : null;
      if (!row || document.activeElement !== row) return;
      const tree = row.closest('[role="tree"]');
      const rows = tree ? [...tree.querySelectorAll<HTMLElement>('[role="treeitem"]')] : [];
      const id = visibleRowIds[rows.indexOf(row)];
      if (!id || id === DRAFT_ID) return;
      event.preventDefault();
      event.stopPropagation();
      moveTask(
        id,
        siblingMove(tasksRef.current, id, event.key === "ArrowUp" ? -1 : 1),
        true,
        "Reordered task"
      );
    };
    document.addEventListener("keydown", onReorderKeyDown, true);
    return () => document.removeEventListener("keydown", onReorderKeyDown, true);
  }, [moveTask, visibleRowIds]);

  if (loading) {
    return <main className="app-state" aria-live="polite"><span className="app-spinner"/><h1>Loading tasks</h1></main>;
  }

  const viewTitle = activeTag
    ? `#${activeTag}`
    : perspectiveDefinitions.find(item => item.id === perspective)?.label ?? "Inbox";
  const parsedPreview = quickText ? parseInboxInput(quickText) : null;
  const quickHighlights = inboxHighlightRanges(quickText);
  const outlineViews = visibleTasks.map(task => taskView(task, expanded, today, editor));

  const renderEditor = (viewTask: TaskViewModel) => {
    if (viewTask.id === DRAFT_ID && editor?.kind === "draft") {
      return <input
        type="text"
        className="app-inline-editor"
        aria-label={`New subtask for ${editor.parentTitle}`}
        value={editor.value}
        onChange={event => setEditor(current => current?.kind === "draft" ? { ...current, value: event.target.value } : current)}
        ref={editorRef}
        autoFocus
        autoComplete="off"
        placeholder="New subtask"
        title="Enter saves · Escape cancels"
        onBlur={() => {
          if (!editor.value.trim()) cancelEditor();
        }}
        onKeyDown={event => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancelEditor();
          } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            void commitEditor();
          }
        }}
      />;
    }
    if (editor?.kind === "existing" && editor.taskId === viewTask.id) {
      return <input
        type="text"
        className="app-inline-editor"
        aria-label={`Edit ${viewTask.title}`}
        value={editor.value}
        onChange={event => setEditor(current => current?.kind === "existing" ? { ...current, value: event.target.value } : current)}
        ref={editorRef}
        autoFocus
        autoComplete="off"
        title="Enter saves · Shift+Enter saves and adds subtask · Escape cancels · Tab changes level"
        onKeyDown={event => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            cancelEditor();
          } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.stopPropagation();
            void commitEditor(event.shiftKey);
          }
        }}
      />;
    }
    return viewTask.title;
  };

  const handleTaskKeyDown = (viewTask: TaskViewModel, event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (viewTask.id === DRAFT_ID) return;
    const target = event.target;
    const fromRow = target === event.currentTarget;
    const fromEditor = target instanceof Element && Boolean(target.closest(".app-inline-editor"));
    if (event.key !== "Tab") return;
    if (!fromRow && !fromEditor) return;
    event.preventDefault();
    const move = event.shiftKey
      ? outdentMove(visibleTasks, viewTask.id)
      : indentMove(visibleTasks, viewTask.id);
    if (move && !event.shiftKey) {
      const fullParent = findTask(tasksRef.current, move.parentId);
      move.position = fullParent?.children.length ?? move.position;
    }
    moveTask(viewTask.id, move, !fromEditor);
  };

  return <TodoKitLayout
    className="app-shell"
    rail={<PerspectiveRail
      activeId={activeTag ? "" : perspective}
      items={railItems}
      onSelect={id => {
        if (!canReplaceEditor()) return;
        setEditor(null);
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
        if (!canReplaceEditor()) return;
        setEditor(null);
        setActiveTag(tag);
        setSelectedId(null);
      }}
      footer={<span><i/>{error ? "Sync interrupted" : "Synced with server"}</span>}
    />}
    main={<>
      {error && <div className="app-error" role="alert"><span>{error}</span><button type="button" onClick={() => void refresh()}>Retry</button></div>}
      <QuickEntry
        value={quickText}
        highlights={quickHighlights}
        onValueChange={setQuickText}
        onSubmit={rawText => {
          if (!rawText.trim() || quickSavePending.current) return;
          const parsed = parseInboxInput(rawText);
          if (!parsed.title || parsed.warnings.length) {
            setStatus("Fix the highlighted task syntax before saving");
            return;
          }
          quickSavePending.current = true;
          void performMutation(
            "Created task",
            () => taskApi.create({ rawText, parentId: null }),
            task => () => taskApi.delete(task.id)
          ).then(created => {
            if (created) setQuickText("");
          }).finally(() => {
            quickSavePending.current = false;
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
      <div className="app-commands">
        <button
          type="button"
          aria-label="Undo last action"
          disabled={!undoHistory.length}
          onClick={undo}
        >Undo{undoHistory.at(-1) ? ` ${undoHistory.at(-1)?.label.toLocaleLowerCase("en-US")}` : ""}</button>
        <span role="status" aria-live="polite">{status}</span>
        <details>
          <summary>Keyboard shortcuts</summary>
          <span>N new root task · ↑/↓ navigate · Alt+↑/↓ reorder · ←/→ collapse or expand · Enter edit/save · Shift+Enter save + subtask · Tab/Shift+Tab indent/outdent · Escape cancel · Ctrl/Cmd+Z undo</span>
        </details>
      </div>
      <TaskOutline
        tasks={outlineViews}
        title={viewTitle}
        headerEyebrow={activeTag ? "Tag" : "Perspective"}
        headerSummary={`${flatten(visibleTasks).filter(task => !task.completed).length} remaining`}
        selectedTaskId={selectedId}
        renderTitle={renderEditor}
        onTaskKeyDown={handleTaskKeyDown}
        onSelect={id => {
          if (id !== DRAFT_ID) openExistingEditor(id);
        }}
        onToggleExpanded={id => setExpanded(current => {
          const next = new Set(current);
          if (next.has(id)) next.delete(id);
          else next.add(id);
          return next;
        })}
        onToggleComplete={id => {
          if (id === DRAFT_ID || pendingCompletions.current.has(id)) return;
          const task = findTask(tasksRef.current, id);
          if (!task) return;
          const completed = !task.completed;
          replaceTasks(replaceTask(tasksRef.current, id, current => ({
            ...current,
            completed,
            completedAt: completed ? current.completedAt : null
          })));
          pendingCompletions.current.add(id);
          void performMutation(
            task.completed ? "Reopened task" : "Completed task",
            () => taskApi.complete(id, completed),
            () => () => taskApi.complete(id, task.completed)
          ).finally(() => {
            pendingCompletions.current.delete(id);
          });
        }}
        onAddSubtask={id => {
          if (id !== DRAFT_ID) openDraftEditor(id);
        }}
      />
    </>}
    inspector={<Details
      key={`${selected?.id ?? "empty"}:${selected?.recurrence ?? ""}`}
      task={selected}
      onChange={inspectorChange}
      onClose={() => {
        if (!canReplaceEditor()) return;
        setEditor(null);
        setSelectedId(null);
      }}
      onRecurrenceChange={recurrence => {
        if (!selected || recurrenceLabel(selected.recurrence) === (recurrence ?? "")) return;
        patchTask(selected.id, { recurrence }, "Edited recurrence");
      }}
      onDelete={() => {
        if (!selected || pendingDeletes.current.has(selected.id)) return;
        const id = selected.id;
        pendingDeletes.current.add(id);
        void performMutation(
          "Deleted task",
          () => taskApi.delete(id),
          result => () => taskApi.restore(result.subtree)
        ).then(result => {
          if (!result) return;
          setEditor(null);
          setSelectedId(null);
        }).finally(() => {
          pendingDeletes.current.delete(id);
        });
      }}
    />}
  />;
}
