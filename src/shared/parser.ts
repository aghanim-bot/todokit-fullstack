import * as chrono from "chrono-node";
import * as rruleModule from "rrule";
import type { InboxHighlightRange, ParsedInboxInput } from "./types.js";

const rruleExports = rruleModule as typeof rruleModule & { default?: typeof rruleModule };
const RRule = rruleExports.RRule ?? rruleExports.default?.RRule;

interface Span {
  start: number;
  end: number;
}

interface SyntaxSpan extends Span {
  kind: Exclude<InboxHighlightRange["kind"], "title">;
}

const weekdayRule = "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR";
const naturalRecurrences: Array<[RegExp, (match: RegExpMatchArray) => string]> = [
  [/\bevery\s+weekdays?\b/i, () => weekdayRule],
  [/\bevery\s+day\b|\bdaily\b/i, () => "RRULE:FREQ=DAILY"],
  [/\bevery\s+week\b|\bweekly\b/i, () => "RRULE:FREQ=WEEKLY"],
  [/\bevery\s+month\b|\bmonthly\b/i, () => "RRULE:FREQ=MONTHLY"],
  [/\bevery\s+year\b|\byearly\b|\bannually\b/i, () => "RRULE:FREQ=YEARLY"],
  [
    /\bevery\s+(\d+)\s+(days?|weeks?|months?|years?)\b/i,
    match => {
      const frequencies: Record<string, string> = {
        day: "DAILY",
        week: "WEEKLY",
        month: "MONTHLY",
        year: "YEARLY"
      };
      const unit = match[2]?.toLocaleLowerCase("en-US").replace(/s$/, "") ?? "";
      return `RRULE:FREQ=${frequencies[unit]};INTERVAL=${Number(match[1])}`;
    }
  ]
];

const naturalDatePattern = /\b(?:today|tomorrow|tonight|next\s+(?:sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|week)|in\s+\d+\s+(?:days?|weeks?)|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?)(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?\b/i;
const dueDatePattern = /\bdue(?:\s+on|:)?\s+((?:\d{4}-\d{2}-\d{2}(?!T)|today|tomorrow|tonight|next\s+(?:sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|week)|(?:sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)|in\s+\d+\s+(?:days?|weeks?)|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm))(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?)/i;
const dueTimestampPattern = /\bdue(?:\s+on|:)?\s+(\d{4}-\d{2}-\d{2}T[^\s#]+)/gi;
const canonicalRecurrencePattern = /\bRRULE:[A-Z0-9=,;+-]+\b/gi;
const malformedRecurrencePattern = /\bevery\s+[^\s#]+(?:\s+[^\s#]+)?/gi;
const malformedDuePattern = /\bdue(?:\s+on|:)?\s+\d{4}-\d{2}-\d{2}\b/gi;

function outsideQuotes(source: string): string {
  let quote: "'" | "\"" | null = null;
  let escaped = false;
  return source.split("").map(character => {
    if (escaped) {
      escaped = false;
      return quote ? " " : character;
    }
    if (character === "\\") {
      escaped = true;
      return quote ? " " : character;
    }
    if (character === "'" || character === "\"") {
      if (quote === character) quote = null;
      else if (!quote) quote = character;
      return " ";
    }
    return quote ? " " : character;
  }).join("");
}

function removeSpans(source: string, spans: Span[]): string {
  if (!spans.length) return source;
  const characters = source.split("");
  for (const { start, end } of spans) {
    for (let index = start; index < end; index += 1) characters[index] = " ";
  }
  return characters.join("").replace(/\s+([,.;])/g, "$1").replace(/\s+/g, " ").trim();
}

function overlaps(left: Span, right: Span): boolean {
  return left.start < right.end && right.start < left.end;
}

function addSpan(spans: SyntaxSpan[], span: SyntaxSpan): boolean {
  if (span.start >= span.end || spans.some(existing => overlaps(existing, span))) return false;
  spans.push(span);
  return true;
}

function allMatches(source: string, pattern: RegExp): RegExpMatchArray[] {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return [...source.matchAll(new RegExp(pattern.source, flags))];
}

function validIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function canonicalDue(result: chrono.ParsedResult): string {
  const year = result.start.get("year");
  const month = result.start.get("month");
  const day = result.start.get("day");
  if (!result.start.isCertain("hour")) {
    return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return result.start.date().toISOString();
}

function findNaturalRecurrence(source: string): { recurrence: string | null; span?: Span } {
  const searchable = outsideQuotes(source);
  for (const [pattern, createRule] of naturalRecurrences) {
    const match = searchable.match(pattern);
    if (match?.index !== undefined) {
      return {
        recurrence: createRule(match),
        span: { start: match.index, end: match.index + match[0].length }
      };
    }
  }
  return { recurrence: null };
}

function unquoteTitle(title: string): string {
  if (title.length < 2) return title;
  const quote = title[0];
  if ((quote !== "\"" && quote !== "'") || title.at(-1) !== quote) return title;
  let escaped = false;
  for (let index = 1; index < title.length - 1; index += 1) {
    const character = title[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === quote) return title;
  }
  return title.slice(1, -1).replace(/\\(["'\\])/g, "$1");
}

interface Analysis {
  parsed: ParsedInboxInput;
  syntaxSpans: SyntaxSpan[];
}

function analyzeInboxInput(input: string, now: Date): Analysis {
  const searchable = outsideQuotes(input);
  const syntaxSpans: SyntaxSpan[] = [];
  const tags: string[] = [];
  let recurrence: string | null = null;
  let dueAt: string | null = null;
  let invalidDate = false;
  let invalidRecurrence = false;

  for (const match of searchable.matchAll(canonicalRecurrencePattern)) {
    if (match.index === undefined) continue;
    const span = { start: match.index, end: match.index + match[0].length };
    try {
      const normalized = normalizeRecurrence(match[0]);
      if (addSpan(syntaxSpans, { ...span, kind: "recurrence" }) && recurrence === null) {
        recurrence = normalized;
      }
    } catch {
      addSpan(syntaxSpans, { ...span, kind: "warning" });
      invalidRecurrence = true;
    }
  }

  for (const [pattern, createRule] of naturalRecurrences) {
    for (const match of allMatches(searchable, pattern)) {
      if (match.index === undefined) continue;
      const span = { start: match.index, end: match.index + match[0].length, kind: "recurrence" as const };
      if (addSpan(syntaxSpans, span) && recurrence === null) recurrence = createRule(match);
    }
  }

  for (const match of searchable.matchAll(malformedRecurrencePattern)) {
    if (match.index === undefined) continue;
    const span = { start: match.index, end: match.index + match[0].length };
    if (addSpan(syntaxSpans, { ...span, kind: "warning" })) invalidRecurrence = true;
  }

  const tagPattern = /(^|\s)#([\p{L}\p{N}_-]+)/gu;
  for (const match of searchable.matchAll(tagPattern)) {
    const prefixLength = match[1]?.length ?? 0;
    const start = (match.index ?? 0) + prefixLength;
    addSpan(syntaxSpans, {
      start,
      end: start + (match[0].length - prefixLength),
      kind: "tag"
    });
    const tag = match[2]?.toLocaleLowerCase("en-US");
    if (tag && !tags.includes(tag)) tags.push(tag);
  }

  for (const match of searchable.matchAll(dueTimestampPattern)) {
    if (match.index === undefined || !match[1]) continue;
    const span = { start: match.index, end: match.index + match[0].length };
    const instant = new Date(match[1]);
    const canonical = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(match[1])
      && !Number.isNaN(instant.valueOf())
      && instant.toISOString() === match[1];
    if (!canonical) {
      if (addSpan(syntaxSpans, { ...span, kind: "warning" })) invalidDate = true;
    } else if (addSpan(syntaxSpans, { ...span, kind: "date" }) && dueAt === null) {
      dueAt = match[1];
    }
  }

  for (const match of allMatches(searchable, dueDatePattern)) {
    if (match.index === undefined || !match[1]) continue;
    const span = { start: match.index, end: match.index + match[0].length };
    const isoDate = /^\d{4}-\d{2}-\d{2}/.test(match[1]) ? match[1].slice(0, 10) : null;
    if (isoDate && !validIsoDate(isoDate)) {
      if (addSpan(syntaxSpans, { ...span, kind: "warning" })) invalidDate = true;
      continue;
    }
    const parsed = chrono.casual.parse(match[1], { instant: now, timezone: 0 }, { forwardDate: true })[0];
    if (!parsed) {
      if (addSpan(syntaxSpans, { ...span, kind: "warning" })) invalidDate = true;
      continue;
    }
    if (addSpan(syntaxSpans, { ...span, kind: "date" }) && dueAt === null) {
      dueAt = canonicalDue(parsed);
    }
  }

  for (const match of searchable.matchAll(malformedDuePattern)) {
    if (match.index === undefined) continue;
    const span = { start: match.index, end: match.index + match[0].length };
    if (addSpan(syntaxSpans, { ...span, kind: "warning" })) invalidDate = true;
  }

  for (const match of allMatches(searchable, naturalDatePattern)) {
    if (match.index === undefined) continue;
    const span = { start: match.index, end: match.index + match[0].length };
    const parsed = chrono.casual.parse(match[0], { instant: now, timezone: 0 }, { forwardDate: true })[0];
    if (!parsed) continue;
    if (addSpan(syntaxSpans, { ...span, kind: "date" }) && dueAt === null) {
      dueAt = canonicalDue(parsed);
    }
  }

  syntaxSpans.sort((left, right) => left.start - right.start || left.end - right.end);
  const cleanTitle = unquoteTitle(removeSpans(
    input,
    syntaxSpans.filter(span => span.kind !== "warning")
  ));
  return {
    parsed: {
      title: cleanTitle,
      dueAt,
      recurrence,
      tags,
      warnings: [
        ...(invalidDate ? ["INVALID_DATE"] : []),
        ...(invalidRecurrence ? ["INVALID_RECURRENCE"] : [])
      ]
    },
    syntaxSpans
  };
}

export function normalizeRecurrence(value: string): string {
  const trimmed = value.trim();
  const natural = findNaturalRecurrence(trimmed);
  if (natural.recurrence && natural.span?.start === 0 && natural.span.end === trimmed.length) {
    return natural.recurrence;
  }
  if (/[\r\n]/.test(trimmed) || /^DTSTART/i.test(trimmed)) {
    throw new Error("Invalid recurrence");
  }
  try {
    if (!RRule) throw new Error();
    const rule = RRule.fromString(trimmed.replace(/^RRULE:/i, ""));
    const canonical = rule.toString();
    if (!canonical.startsWith("RRULE:") || canonical.includes("\n")) throw new Error();
    return canonical;
  } catch {
    throw new Error("Invalid recurrence");
  }
}

export function parseInboxInput(input: string, now = new Date()): ParsedInboxInput {
  return analyzeInboxInput(input, now).parsed;
}

export function inboxHighlightRanges(input: string, now = new Date()): InboxHighlightRange[] {
  const syntaxSpans = analyzeInboxInput(input, now).syntaxSpans;
  const ranges: InboxHighlightRange[] = [];
  let cursor = 0;
  for (const span of syntaxSpans) {
    if (span.start > cursor) ranges.push({ start: cursor, end: span.start, kind: "title" });
    ranges.push(span);
    cursor = span.end;
  }
  if (cursor < input.length) ranges.push({ start: cursor, end: input.length, kind: "title" });
  return ranges;
}

export interface EditableTaskSyntax {
  title: string;
  dueAt: string | null;
  recurrence: string | null;
  tags: string[];
}

function formatDueAt(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return `due ${value}`;
  const date = new Date(value);
  if (date.getUTCSeconds() || date.getUTCMilliseconds()) return `due ${value}`;
  const hours = date.getUTCHours();
  const minutes = date.getUTCMinutes();
  const suffix = hours >= 12 ? "pm" : "am";
  const clockHours = hours % 12 || 12;
  const minuteText = minutes ? `:${String(minutes).padStart(2, "0")}` : "";
  return `due ${date.toISOString().slice(0, 10)} at ${clockHours}${minuteText}${suffix}`;
}

function quoteTitleIfNeeded(title: string): string {
  if (
    !analyzeInboxInput(title, new Date(0)).syntaxSpans.length
    && unquoteTitle(title) === title
  ) return title;
  return `"${title.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

export function taskToEditableRawText(task: EditableTaskSyntax): string {
  return [
    quoteTitleIfNeeded(task.title),
    task.dueAt ? formatDueAt(task.dueAt) : "",
    task.recurrence ?? "",
    ...[...new Set(task.tags.map(tag => tag.replace(/^#/, "").toLocaleLowerCase("en-US")))]
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
      .map(tag => `#${tag}`)
  ].filter(Boolean).join(" ");
}
