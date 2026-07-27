import * as chrono from "chrono-node";
import * as rruleModule from "rrule";
import type { ParsedInboxInput } from "./types.js";

const rruleExports = rruleModule as typeof rruleModule & { default?: typeof rruleModule };
const RRule = rruleExports.RRule ?? rruleExports.default?.RRule;

interface Span {
  start: number;
  end: number;
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
const dueDatePattern = /\bdue(?:\s+on|:)?\s+((?:\d{4}-\d{2}-\d{2}|today|tomorrow|tonight|next\s+(?:sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|week)|(?:sun(?:day)?|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?)|in\s+\d+\s+(?:days?|weeks?)|(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?|at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm))(?:\s+at\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?)?)/i;

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
  let title = input.trim();
  let invalidDate = false;

  const recurrenceResult = findNaturalRecurrence(title);
  const hasInvalidRecurrence = /\bevery\s+\S+/i.test(outsideQuotes(title))
    && !recurrenceResult.recurrence;
  if (recurrenceResult.span) title = removeSpans(title, [recurrenceResult.span]);

  const tagSearch = outsideQuotes(title);
  const tagPattern = /(^|\s)#([\p{L}\p{N}_-]+)/gu;
  const tagSpans: Span[] = [];
  const tags: string[] = [];
  for (const match of tagSearch.matchAll(tagPattern)) {
    const prefixLength = match[1]?.length ?? 0;
    const start = (match.index ?? 0) + prefixLength;
    tagSpans.push({ start, end: start + (match[0].length - prefixLength) });
    const tag = match[2]?.toLocaleLowerCase("en-US");
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  title = removeSpans(title, tagSpans);

  let dueAt: string | null = null;
  const searchable = outsideQuotes(title);
  const explicit = searchable.match(dueDatePattern);
  let dateSpan: Span | undefined;
  let dateText: string | undefined;
  if (explicit?.index !== undefined && explicit[1]) {
    const isoDate = /^\d{4}-\d{2}-\d{2}/.test(explicit[1]) ? explicit[1].slice(0, 10) : null;
    if (isoDate && !validIsoDate(isoDate)) {
      invalidDate = true;
    } else {
      dateSpan = { start: explicit.index, end: explicit.index + explicit[0].length };
      dateText = explicit[1];
    }
  } else {
    const natural = searchable.match(naturalDatePattern);
    if (natural?.index !== undefined) {
      dateSpan = { start: natural.index, end: natural.index + natural[0].length };
      dateText = natural[0];
    }
  }

  if (dateSpan && dateText) {
    const parsed = chrono.casual.parse(dateText, { instant: now, timezone: 0 }, { forwardDate: true });
    if (parsed[0]) {
      dueAt = canonicalDue(parsed[0]);
      title = removeSpans(title, [dateSpan]);
    } else {
      invalidDate = true;
    }
  }

  const warnings = [
    ...(invalidDate ? ["INVALID_DATE"] : []),
    ...(hasInvalidRecurrence ? ["INVALID_RECURRENCE"] : [])
  ];
  return { title, dueAt, recurrence: recurrenceResult.recurrence, tags, warnings };
}
