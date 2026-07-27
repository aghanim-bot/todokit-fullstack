# Data types and API contracts

## Sources of truth

`src/shared/types.ts` contains compile-time TypeScript interfaces shared by the browser and server:

- `Task`
- `ParsedInboxInput`
- `ApiErrorBody`

`CreateTaskInput` and `UpdateTaskInput` in `src/server/task-repository.ts` are also compile-time interfaces. TypeScript interfaces are erased at build time and do not validate network input.

Runtime request validation is defined separately with Zod in `src/server/validation.ts`: `createTaskSchema`, `resolvedCreateTaskSchema`, `updateTaskSchema`, `completionSchema`, and `idParamsSchema`. All request objects are strict, so unknown keys are rejected. Responses are constructed by application code and are typed at compile time; there is no response-side Zod parse.

Todokit's `TaskViewModel` and `TaskInspectorViewModel` are dependency-owned compile-time UI contracts. `App.tsx` derives them from `Task`; they are not API or database types.

## `Task`

The API returns this recursive domain type:

```ts
interface Task {
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
```

| Field | Semantics |
| --- | --- |
| `id` | Server-generated UUID from `randomUUID()`. Request path IDs must pass Zod's UUID validator. |
| `parentId` | Parent task UUID, or `null` for a database root. In a single-task subtree response, the returned root can still have a non-null `parentId` outside the response. |
| `title` | Required task label. Input is trimmed and must contain 1–500 characters after trimming. |
| `notes` | Free text. Defaults to `""`; API input is limited to 20,000 characters and is not trimmed. |
| `dueAt` | Due date, due instant, or `null`; accepted formats are described below. |
| `reviewAt` | Review date, review instant, or `null`; validated with the same formats as `dueAt`. |
| `recurrence` | One canonical RFC 5545 recurrence line beginning `RRULE:`, or `null`. It is stored metadata only. |
| `completed` | Boolean completion state. Stored as SQLite integer `0` or `1`. |
| `completedAt` | UTC ISO timestamp set when a task first transitions from incomplete to complete; `null` while incomplete. Re-sending `completed: true` to an already completed task preserves the prior timestamp. |
| `flagged` | Boolean flag state. Stored as SQLite integer `0` or `1`. |
| `position` | Zero-based append position among the task's current siblings. It is stable but not exposed as writable API input. |
| `createdAt` | Server-generated UTC ISO timestamp. Immutable through the API. |
| `updatedAt` | Server-generated UTC ISO timestamp, replaced by every repository update, including a completion update or an otherwise value-equivalent patch. |
| `tags` | Normalized tag names, returned in case-insensitive name order. |
| `depth` | Depth relative to the current query anchor: roots from the full list are `0`; the requested task from a subtree read is also `0`. |
| `children` | Recursively nested children in stable sibling order; always present, including as `[]`. |

### Root task with a subtask

This is the shape inside the `data` property of `GET /api/tasks`:

```json
[
  {
    "id": "11111111-1111-4111-8111-111111111111",
    "parentId": null,
    "title": "Release checklist",
    "notes": "",
    "dueAt": "2026-08-01",
    "reviewAt": null,
    "recurrence": null,
    "completed": false,
    "completedAt": null,
    "flagged": true,
    "position": 0,
    "createdAt": "2026-07-27T09:00:00.000Z",
    "updatedAt": "2026-07-27T09:00:00.000Z",
    "tags": ["work"],
    "depth": 0,
    "children": [
      {
        "id": "22222222-2222-4222-8222-222222222222",
        "parentId": "11111111-1111-4111-8111-111111111111",
        "title": "Verify package",
        "notes": "Run the release checks.",
        "dueAt": null,
        "reviewAt": null,
        "recurrence": null,
        "completed": false,
        "completedAt": null,
        "flagged": false,
        "position": 0,
        "createdAt": "2026-07-27T09:05:00.000Z",
        "updatedAt": "2026-07-27T09:05:00.000Z",
        "tags": ["work"],
        "depth": 1,
        "children": []
      }
    ]
  }
]
```

## `ParsedInboxInput`

The parser's compile-time return type is:

```ts
interface ParsedInboxInput {
  title: string;
  dueAt: string | null;
  recurrence: string | null;
  tags: string[];
  warnings: string[];
}
```

| Field | Semantics |
| --- | --- |
| `title` | Input with recognized recurrence, tags, and due-date spans removed; whitespace is collapsed around removals. |
| `dueAt` | Recognized date-only or UTC timestamp, otherwise `null`. |
| `recurrence` | Recognized canonical RRULE, otherwise `null`. |
| `tags` | Tags recognized outside quotes, lowercased with the `en-US` locale and de-duplicated in encounter order. |
| `warnings` | Zero or more parser codes. Current values are `INVALID_DATE` and `INVALID_RECURRENCE`. |

Warnings make a server-side raw-text create fail with `422 PARSE_ERROR`. The browser parser uses the same return type only for a preview.

## Date formats

`dueAt` and `reviewAt` accept only:

- a real calendar date in exact `YYYY-MM-DD` form; or
- a real UTC instant in exact `YYYY-MM-DDTHH:mm:ss.sssZ` form whose `Date.toISOString()` round-trip is identical.

Offsets, omitted milliseconds, local timestamps, and date-time strings not ending in `Z` fail validation. `createdAt`, `updatedAt`, and non-null `completedAt` are server-generated `Date.toISOString()` values.

The parser keeps date-only phrases date-only. A phrase with a certain hour becomes a UTC timestamp. Parsing uses UTC and defaults to the server's current instant when the caller does not supply a reference date.

## Recurrence

Non-null recurrence input is trimmed, limited to 1–500 characters before normalization, and passed through `normalizeRecurrence`. The stored form is a single canonical line beginning `RRULE:`. A leading `RRULE:` is optional on explicit input, but the canonical output contains it.

Supported natural forms are:

- `daily`, `weekly`, `monthly`, `yearly`, and `annually`;
- `every day|week|month|year`;
- `every weekday` or `every weekdays`;
- `every N days|weeks|months|years`.

For example, `every 2 weeks` becomes `RRULE:FREQ=WEEKLY;INTERVAL=2`, and `every weekday` becomes `RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR`. Other valid single RRULE strings are parsed and reserialized by `rrule`. Multiline values and values beginning with `DTSTART` are rejected.

Recurrence does not create a future task when completion changes.

## Tags

Explicit request tags are an array with at most 20 entries. Each entry is trimmed, must be 1–50 characters, and may contain Unicode letters, Unicode numbers, `_`, or `-`. An explicit `#work` value fails Zod validation because `#` is not allowed.

The raw inbox parser recognizes `#` only at the beginning of a whitespace-delimited token and ignores quoted or embedded hashes. Before persistence, the repository trims, strips one optional leading `#` for repository callers, lowercases with `toLocaleLowerCase("en-US")`, removes duplicates, drops empty values, and sorts. The database stores one normalized name in `tags` and many-to-many links in `task_tags`; API reads sort names with SQLite `COLLATE NOCASE`.

Sending `tags: []` on patch removes every tag link. Omitting `tags` preserves the current links.

## Create payload

`POST /api/tasks` accepts either raw text or an explicit title, never both.

### Raw-text create

```json
{
  "rawText": "Submit report tomorrow at 5pm every weekday #work #urgent",
  "flagged": true
}
```

`rawText` is trimmed and limited to 1–1,000 characters. The parser supplies `title`, `dueAt`, `recurrence`, and `tags`. These optional request fields override or supplement parsed values:

| Field | Raw-create behavior |
| --- | --- |
| `parentId` | Copied to the resolved create input. |
| `notes` | Copied. |
| `dueAt` | When present, including `null`, overrides the parsed date. |
| `recurrence` | When present, including `null`, overrides parsed recurrence. |
| `completed` / `flagged` | Copied. |
| `tags` | When present, including `[]`, replaces parsed tags. |
| `reviewAt` | Accepted by the first Zod schema but currently not copied into the resolved raw-create input, so it is stored as `null`. |

Parser warnings or an empty parsed title produce `422 PARSE_ERROR`.

### Explicit create

```json
{
  "parentId": "11111111-1111-4111-8111-111111111111",
  "title": "Verify package",
  "notes": "Run the release checks.",
  "dueAt": "2026-08-01",
  "reviewAt": null,
  "recurrence": "every 2 weeks",
  "completed": false,
  "flagged": true,
  "tags": ["release", "work"]
}
```

Create fields and defaults:

| Field | Validation and default |
| --- | --- |
| `parentId` | UUID, `null`, or omitted. `null`/omitted creates a root. A missing referenced task returns `404`. |
| `title` | Required when `rawText` is absent; trimmed, 1–500 characters. |
| `notes` | String up to 20,000 characters; default `""`. |
| `dueAt`, `reviewAt` | Valid date string, `null`, or omitted; default `null`. |
| `recurrence` | Trimmed string 1–500 characters, `null`, or omitted; default `null`; non-null values are canonicalized. |
| `completed` | Boolean; default `false`. When created `true`, `completedAt` equals the creation timestamp. |
| `flagged` | Boolean; default `false`. |
| `tags` | Up to 20 valid tags; default `[]`. |

The server generates `id`, sibling `position`, all audit timestamps, `completedAt`, `depth`, and `children`.

## Update payload

`PATCH /api/tasks/:id` accepts any nonempty subset of the create task fields except `rawText`. Unknown fields and an empty object fail with `400 VALIDATION_ERROR`.

```json
{
  "title": "Verify release package",
  "dueAt": null,
  "recurrence": "RRULE:FREQ=WEEKLY;COUNT=5",
  "tags": [],
  "flagged": false
}
```

Omitted fields preserve their current values. Explicit `null` clears `parentId`, `dueAt`, `reviewAt`, or `recurrence`; the non-nullable fields cannot be cleared with `null`. `parentId: null` moves a task to root level. A move appends it after the destination's current siblings and returns `409 CONFLICT` if the destination is the task itself or one of its descendants. `completed` is accepted on this general patch route as well as through the dedicated completion route.

The current implementation checks `if (patch.tags)` before replacement. Both `[]` and nonempty arrays are truthy in JavaScript, so either replaces the links; only omission preserves them.

## Completion payload

`POST /api/tasks/:id/completion` requires exactly:

```json
{
  "completed": true
}
```

Completing an incomplete task sets `completedAt` to the current UTC timestamp. Repeating `true` preserves that timestamp. Sending `false` sets `completedAt` to `null`. The route updates only that task; it does not cascade completion to ancestors or descendants and does not generate a recurrence.

## Success envelopes

Application API routes wrap their result in `data`. Create returns HTTP `201`; the other task routes return `200`.

```json
{
  "data": {
    "id": "11111111-1111-4111-8111-111111111111",
    "parentId": null,
    "title": "Submit report",
    "notes": "",
    "dueAt": "2026-07-28T17:00:00.000Z",
    "reviewAt": null,
    "recurrence": "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
    "completed": false,
    "completedAt": null,
    "flagged": true,
    "position": 0,
    "createdAt": "2026-07-27T09:00:00.000Z",
    "updatedAt": "2026-07-27T09:00:00.000Z",
    "tags": ["urgent", "work"],
    "depth": 0,
    "children": []
  }
}
```

Delete returns a count that includes the requested task and every deleted descendant:

```json
{
  "data": {
    "deleted": 3
  }
}
```

`GET /health` is the sole exception to the success envelope:

```json
{
  "status": "ok"
}
```

## Error envelope

The compile-time interface is:

```ts
interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
```

A runtime Zod failure includes issue paths and messages:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [
      {
        "path": "title",
        "message": "Too small: expected string to have >=1 characters"
      }
    ]
  }
}
```

`details` is omitted when the error has no details. Parser errors can instead use an object:

```json
{
  "error": {
    "code": "PARSE_ERROR",
    "message": "Inbox text contains an invalid date or recurrence",
    "details": {
      "warnings": ["INVALID_DATE"]
    }
  }
}
```

Current error classes include:

| HTTP status | Code | Cause |
| --- | --- | --- |
| `400` | `VALIDATION_ERROR` | Zod parameter/body failure, including unknown fields or empty patch. |
| `400` | `INVALID_REQUEST` | Malformed request, such as invalid JSON. |
| `404` | `NOT_FOUND` | Missing task/parent or unknown route. |
| `409` | `CONFLICT` | Attempted task cycle. |
| `413` | `PAYLOAD_TOO_LARGE` | Body exceeds 64 KiB. |
| `422` | `PARSE_ERROR` | Raw inbox warning or missing parsed title. |
| `422` | `VALIDATION_ERROR` | Recurrence normalization failure. |
| `500` | `INTERNAL_ERROR` | Unhandled server failure. |

## Database-to-API mapping

| SQLite/result field | API field | Conversion |
| --- | --- | --- |
| `id` | `id` | Text unchanged. |
| `parent_id` | `parentId` | Nullable text unchanged. |
| `title` | `title` | Text unchanged. |
| `notes` | `notes` | Text unchanged. |
| `due_at` | `dueAt` | Nullable text unchanged. |
| `review_at` | `reviewAt` | Nullable text unchanged. |
| `recurrence` | `recurrence` | Nullable text unchanged. |
| `completed` | `completed` | Integer converted with `Boolean(...)`. |
| `completed_at` | `completedAt` | Nullable text unchanged. |
| `flagged` | `flagged` | Integer converted with `Boolean(...)`. |
| `position` | `position` | Integer unchanged. |
| `created_at` | `createdAt` | Text unchanged. |
| `updated_at` | `updatedAt` | Text unchanged. |
| recursive CTE `depth` | `depth` | Integer unchanged. |
| aggregate `tags_json` | `tags` | JSON text parsed as `string[]`. |
| no stored column | `children` | Initialized to `[]`, then populated by `rowsToTree`. |
