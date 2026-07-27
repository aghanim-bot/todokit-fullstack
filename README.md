# Todokit Full Stack

A production-oriented, single-user todo application built with React, Vite, Fastify, and SQLite. The interface consumes [Todokit](https://github.com/aghanim-bot/todokit) as a pinned GitHub npm dependency; its components are not copied into this repository.

## Architecture

- `src/client`: controlled React UI using Todokit's layout, quick entry, recursive outline, and inspector. Vite proxies API calls in development and creates the production bundle.
- `src/server`: Fastify HTTP API, Zod request validation, graceful shutdown, schema migrations, and a repository containing only handwritten, parameterized SQL.
- `src/shared`: end-to-end task contracts plus deterministic inbox parsing built on `chrono-node` and `rrule`.
- SQLite is the source of truth. Tests create isolated temporary or in-memory databases and never use developer data.
- In production, Fastify serves both the API and Vite's static output from one process on port `3001`.

### Schema

Every task and subtask is one row in the self-referencing `tasks` table:

| Column | Purpose |
| --- | --- |
| `id` | UUID primary key |
| `parent_id` | Nullable foreign key to `tasks.id`, with cascading deletion |
| `title`, `notes` | Task content |
| `due_at`, `review_at` | Date-only or UTC ISO-8601 values |
| `recurrence` | Canonical RFC 5545 RRULE |
| `completed`, `completed_at`, `flagged` | Task state |
| `position` | Stable order among siblings |
| `created_at`, `updated_at` | UTC audit timestamps |

Tags are intentionally normalized into `tags` and `task_tags`. Foreign keys, check constraints, useful partial/compound indexes, transactional writes, and automatic unused-tag cleanup are enabled at initialization. No ORM or query builder is used.

### Recursive tree SQL

Tree reads use `WITH RECURSIVE`. Each row carries its depth and a stable path assembled from sibling position and ID:

```sql
WITH RECURSIVE tree AS (
  SELECT tasks.*, 0 AS depth,
         printf('%012d:%s', position, id) AS sort_path
  FROM tasks
  WHERE parent_id IS NULL
  UNION ALL
  SELECT child.*, tree.depth + 1,
         tree.sort_path || '/' ||
         printf('%012d:%s', child.position, child.id)
  FROM tasks AS child
  JOIN tree ON child.parent_id = tree.id
)
SELECT * FROM tree ORDER BY sort_path;
```

The same technique anchors a subtree at one ID for inspection. Moves close the source sibling gap, open the exact destination position, and reject cycles in one transaction. Deletion snapshots the recursive subtree before removing it and compacting siblings; the validated restore endpoint inserts the same IDs, parents, positions, fields, timestamps, and tags transactionally for undo.

## Inbox syntax

Quick entry extracts recognized metadata and leaves a clean title. Parsing uses the server's current UTC calendar as the reference, so the same input and reference instant always produce the same result.

```text
Submit report tomorrow at 5pm every weekday #work #urgent
→ title: Submit report
→ dueAt: <tomorrow>T17:00:00.000Z
→ recurrence: RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR
→ tags: work, urgent

Pay rent due 2026-08-01 monthly #finance
→ title: Pay rent
→ dueAt: 2026-08-01
→ recurrence: RRULE:FREQ=MONTHLY
→ tags: finance
```

Supported date syntax includes `today`, `tomorrow`, `tonight`, `next fri`, `next week`, `in 2 days`, common English month/day forms, optional `at 5pm`, and explicit `due 2026-08-01` / `due:2026-08-01`. Date-only values remain `YYYY-MM-DD`; values with a time are stored as canonical UTC ISO timestamps.

Supported natural recurrence syntax is `daily`, `weekly`, `monthly`, `yearly`, `annually`, `every weekday`, and `every N days|weeks|months|years`. Canonical recurrence storage is one RFC 5545 line beginning with `RRULE:`. The details pane also accepts a valid single RRULE.

Tags begin with `#` at the start of a token and contain letters, numbers, underscores, or hyphens. They are case-normalized and de-duplicated. Hashes inside single or double quotes, embedded hashes such as `C#`, and email-like text are left alone. Invalid explicit dates or `every …` expressions are not silently removed: the API returns `422 PARSE_ERROR`, while the client preview warns before submission. This constrained recognition avoids treating ordinary words such as “May” or “Friday team” as accidental dates.

Quick entry and inline row editors use Todokit's native-input highlighting backdrop. The shared parser supplies exact, non-overlapping `title`, `date`, `recurrence`, `tag`, and `warning` source ranges; rendering uses React text nodes rather than HTML injection.

## Keyboard workflow

- `Arrow Up` / `Arrow Down`, `Home` / `End`: move through visible tasks.
- `Arrow Right` / `Arrow Left`: expand/collapse or move to a child/parent.
- `Enter` or click a task title: select it and edit in place; `Enter` again saves.
- `Shift+Enter`: save an existing task and open a new inline subtask draft.
- `Escape`: cancel the current edit/draft and return focus to the selected row.
- `Tab` / `Shift+Tab` on a focused row or its inline editor: indent under the previous visible sibling / outdent after the parent. Tab remains native in quick entry, inspector fields, and nested buttons.
- `Ctrl+Z` / `Cmd+Z` outside text controls: undo the latest successful app mutation. Native text undo is preserved while typing.

The row `+` action creates one unsaved inline draft; no prompt or modal is used. Empty drafts cancel on blur, and non-empty drafts require explicit Enter or Escape. The visible Undo/status strip and keyboard-help disclosure repeat these commands in the app.

## API

All successful application responses wrap payloads in `{ "data": ... }`. Errors always use:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": []
  }
}
```

| Method | Path | Behavior |
| --- | --- | --- |
| `GET` | `/health` | Database-backed liveness check |
| `GET` | `/api/tasks` | Complete recursive task tree |
| `GET` | `/api/tasks/:id` | Task and its recursive subtree |
| `POST` | `/api/tasks` | Create root/subtask from `rawText` or explicit fields |
| `PATCH` | `/api/tasks/:id` | Edit structured fields or replace title/date/recurrence/tags from `{ "rawText": "..." }` |
| `POST` | `/api/tasks/:id/completion` | Complete/uncomplete with `{ "completed": true }` |
| `POST` | `/api/tasks/:id/move` | Move to exact `{ "parentId": null, "position": 0 }` with sibling reindexing |
| `DELETE` | `/api/tasks/:id` | Delete and return `{ deleted, subtree }` for exact undo |
| `POST` | `/api/tasks/restore` | Transactionally restore a validated recursive subtree snapshot |

Unknown fields, malformed UUIDs, invalid dates/tags/recurrence, empty updates, missing parents, missing tasks, and cycles receive appropriate `400`, `404`, `409`, or `422` responses.

## Local development

Node.js 22 or later is required. The GitHub-hosted Todokit dependency also requires Git during install.

```sh
npm install
npm run dev
```

Open <http://localhost:5173>. Vite runs the client and proxies to Fastify on port `3001`.

Production-style local execution:

```sh
npm run build
npm start
# open http://localhost:3001
```

### Database location

`TODO_DB_PATH` selects the SQLite file. The application recursively creates a missing parent directory and initializes/migrates a missing database. When unset, it defaults to `./data/todos.sqlite`, relative to the process working directory.

```sh
TODO_DB_PATH="$PWD/.local/state/todos.sqlite" npm run dev
```

The container sets `TODO_DB_PATH=/data/todos.sqlite`; mount persistent storage at `/data`. SQLite also creates `-wal` and `-shm` files beside the database, so the entire directory must be writable.

## Docker

Build and run locally:

```sh
docker build -t todokit-fullstack .
docker run --rm -p 3001:3001 \
  -v todokit-data:/data \
  -e TODO_DB_PATH=/data/todos.sqlite \
  todokit-fullstack
```

The multi-stage image builds as Node 22, runs as the unprivileged `node` user, declares `/data` as a volume, and includes an HTTP health check.

Compose is an executable equivalent:

```sh
docker compose up --build
```

Pull and run the published GHCR image:

```sh
docker pull ghcr.io/aghanim-bot/todokit-fullstack:latest
docker run --rm -p 3001:3001 -v todokit-data:/data \
  ghcr.io/aghanim-bot/todokit-fullstack:latest
```

The container workflow publishes `linux/amd64` and `linux/arm64` images on `main` and `v*.*.*` tags using only `GITHUB_TOKEN`.

## Quality checks

```sh
npm run lint
npm run typecheck
npm test
npm run build
# or all four:
npm run check
```

Vitest covers parser ranges/round trips, tree move helpers, real-SQLite move/restore rollback and ordering, every API inverse flow, and keyboard-first React interactions including inline drafts, focus, highlighting, and native/global undo discrimination.

## Limitations

- There is no authentication or multi-user ownership; deploy it as a private single-user service unless an auth layer is added.
- Recurrence is parsed, validated, stored, and editable, but this version does not automatically generate the next occurrence when a task is completed.
- Natural-language parsing intentionally supports a documented English subset instead of guessing at every date-like phrase.
- Sibling ordering is maintained through keyboard indent/outdent; drag-and-drop and arbitrary same-level reordering are not exposed.

## Deeper documentation

See the [documentation index](docs/README.md) for detailed architecture, interaction and undo semantics, data contracts, and database references.

## License

[MIT](LICENSE)
