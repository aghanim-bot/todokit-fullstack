# Interaction model

## Ownership boundary

Todokit supplies the controlled layout, native highlighted inputs, and ARIA tree-row navigation. `src/client/App.tsx` owns task selection, expansion, editor state, filtering, server mutations, and undo history. The server and SQLite remain authoritative; browser state is not durable.

Three task concepts are intentionally separate:

- **Selection** identifies the task shown in the inspector and edited by application actions.
- **Focus** identifies the keyboard-active visible tree row. Todokit's `TaskOutline` maintains the roving row tab stop.
- **Editor state** identifies either one existing task being edited or one unsaved child draft. At most one editor exists.

A refresh preserves selection only when the selected task still exists. It also closes an existing editor whose task disappeared and closes a draft whose parent disappeared. Otherwise the current editor text is preserved while refreshed task metadata is adopted.

## Tree navigation

When focus is on a task row:

| Key | Behavior |
| --- | --- |
| `ArrowDown` / `ArrowUp` | Focus the next or previous visible row. |
| `Home` / `End` | Focus the first or last visible row. |
| `ArrowRight` | Expand a collapsed parent, or focus its first visible child when already expanded. |
| `ArrowLeft` | Collapse an expanded parent, or focus the visible parent. |
| `Enter` / `Space` | Select the row. In this application, selection opens the existing-task editor. |
| `Tab` | Indent beneath the previous visible sibling, when one exists. |
| `Shift+Tab` | Outdent one level and place the task after its former parent. |

Todokit owns the six arrow/Home/End navigation keys. `App` handles Tab through `onTaskKeyDown`. Tab is intercepted only when the event originates from the row itself or its inline editor; quick entry, inspector controls, row buttons, and other nested controls retain native Tab behavior.

Indentation is derived from the currently filtered tree. An indent appends the task after all children of the chosen full-tree parent, including children hidden by the current filter. The exact move API still validates parent, cycle, and position invariants. A task without a previous sibling cannot indent, and a root cannot outdent.

## Existing-task editing

Clicking a task's noninteractive row content or selecting it with Enter/Space opens a `HighlightedInput` in the row title slot. The editor starts with `taskToEditableRawText(task)`, a deterministic representation of the title, due value, recurrence, and sorted tags. Notes, review date, flag, completion, hierarchy, and timestamps are not represented in this text editor.

The shared parser runs on every value change and provides `title`, `date`, `recurrence`, `tag`, and `warning` ranges. The client does not submit empty text, an empty parsed title, or parser warnings.

| Action | Result |
| --- | --- |
| `Enter` | Send one `{ rawText }` patch and close the editor after success. |
| `Shift+Enter` | Save the task, expand it, and open an empty child draft beneath it. |
| `Escape` | Discard the local value and restore focus to the selected row. |
| `Tab` / `Shift+Tab` | Move the task without closing or stealing focus from the editor. |

The server reparses raw text and atomically replaces title, due date, recurrence, and tags. It is authoritative even though the browser uses the same parser for preview and validation.

Switching task, perspective, tag, or closing the inspector is blocked while an editor contains unsaved nonempty changes. The user must save with Enter or cancel with Escape. An unchanged existing editor or an empty editor may be replaced.

## Inline child drafts

The row `+` action inserts one client-only child with the sentinel ID `__local-subtask-draft__`; it does not call `window.prompt`, open a modal, or write to the API. The parent is selected and expanded, and the draft input receives focus.

- Enter parses and creates the child with `{ rawText, parentId }`.
- Escape cancels without a request.
- Blurring an empty draft cancels it.
- Blurring a nonempty draft leaves it pending; explicit Enter or Escape is required.
- Parser warnings leave the draft open and expose corrective status text.
- Only one draft or existing editor can be active at a time.

After successful creation, the server task is selected and row focus is restored. Creating a child through Shift+Enter follows the same draft lifecycle after the parent edit succeeds.

## Highlighting and composition

Quick entry and both inline editor forms derive ranges with `inboxHighlightRanges`. Todokit's `HighlightedInput` keeps a real native input above a pointer-inert, `aria-hidden` React-rendered backdrop. No input content is passed to `innerHTML`.

Enter does not submit an inline editor while the native event reports IME composition. Native caret, selection, and composition behavior therefore remains with the input. Quick entry uses its ordinary form submission path.

## Mutation queue

All mutations and undo operations share one promise chain. This produces a deterministic server order even when the user triggers operations faster than requests complete. A rejected operation does not break later queue entries.

After a successful forward mutation, the client:

1. records an inverse closure;
2. updates the visible status;
3. reloads the complete tree from the server.

Completion and inspector edits also update local task state before their queued request to keep controls responsive. The subsequent full refresh reconciles that optimistic state with SQLite.

A forward mutation failure clears undo history because earlier captured inverses may no longer describe the refreshed server state. The client displays the original error and attempts a refresh. A mutation that succeeds but is followed by a failed refresh remains recorded as undoable.

## Undo semantics

The client keeps at most 100 successful mutation inverses in memory. Undo is LIFO and is available through the visible button or `Ctrl+Z` / `Cmd+Z` outside text-editing controls. There is no redo stack, and history does not survive a page reload.

Native text undo takes precedence for inputs, textareas, selects, content-editable elements, and textbox/searchbox/combobox/spinbutton roles. Modified shortcuts using Shift or Alt and repeated keydown events are not treated as application undo.

| Forward action | Stored inverse |
| --- | --- |
| Create root or child | Delete the returned task ID. |
| Inline raw edit | Patch the previous title, due date, recurrence, and tags. |
| Inspector edit | Patch exactly the fields changed, using their previous values. |
| Complete or reopen | Restore the previous completion boolean. |
| Indent or outdent | Move to the parent and sibling position observed when the queued move actually begins. |
| Recursive delete | Restore the exact subtree snapshot returned by delete. |

Execution-time move capture is important: queued moves can change positions before a later move begins. Recursive restore preserves IDs, hierarchy, sibling positions, fields, timestamps, tags, and descendants transactionally.

An inverse is removed from history only after it succeeds. If an inverse fails, it remains available for retry, the client reports the failure, and it attempts to refresh. Undo itself is not recorded as a new forward action.

## Accessibility and status

The outline retains Todokit's `tree`/`treeitem` semantics, one roving tab stop, levels, sibling positions, set sizes, expansion state, and controlled selection while application editors replace only title content. Editor descriptions expose save/cancel/indent commands. The mutation strip uses an ARIA live status, errors use `role="alert"`, and the keyboard-help disclosure mirrors the primary commands.
