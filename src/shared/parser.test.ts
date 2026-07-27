import { describe, expect, it } from "vitest";
import {
  inboxHighlightRanges,
  normalizeRecurrence,
  parseInboxInput,
  taskToEditableRawText
} from "./parser.js";

const now = new Date("2026-07-27T09:00:00.000Z");

describe("parseInboxInput", () => {
  it("extracts a natural due time, weekday recurrence, and unique normalized tags", () => {
    expect(parseInboxInput(
      "Submit report tomorrow at 5pm every weekday #Work #urgent #work",
      now
    )).toEqual({
      title: "Submit report",
      dueAt: "2026-07-28T17:00:00.000Z",
      recurrence: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
      tags: ["work", "urgent"],
      warnings: []
    });
  });

  it("parses explicit due dates and monthly recurrence", () => {
    expect(parseInboxInput("Pay rent due 2026-08-01 monthly #finance", now)).toEqual({
      title: "Pay rent",
      dueAt: "2026-08-01",
      recurrence: "RRULE:FREQ=MONTHLY",
      tags: ["finance"],
      warnings: []
    });
  });

  it("parses due-prefixed natural weekdays and removes the complete phrase", () => {
    expect(parseInboxInput("Call supplier due Friday at 5pm #work", now)).toMatchObject({
      title: "Call supplier",
      dueAt: "2026-07-31T17:00:00.000Z",
      tags: ["work"]
    });
    expect(parseInboxInput("Prepare agenda due tomorrow", now).title).toBe("Prepare agenda");
  });

  it("does not treat quoted hashes or embedded hashes as tags", () => {
    expect(parseInboxInput(
      'Discuss "#Launch day" and C# with dev@example.com #Team #team',
      now
    )).toMatchObject({
      title: 'Discuss "#Launch day" and C# with dev@example.com',
      tags: ["team"]
    });
  });

  it("keeps invalid date and recurrence text in the clean title and reports warnings", () => {
    expect(parseInboxInput("Review due 2026-02-30 every blue moon #ops", now)).toEqual({
      title: "Review due 2026-02-30 every blue moon",
      dueAt: null,
      recurrence: null,
      tags: ["ops"],
      warnings: ["INVALID_DATE", "INVALID_RECURRENCE"]
    });
  });

  it("warns on a noncanonical due timestamp without partially consuming its date", () => {
    const source = "Review due 2026-08-01T17:30:00Z #ops";
    expect(parseInboxInput(source, now)).toEqual({
      title: "Review due 2026-08-01T17:30:00Z",
      dueAt: null,
      recurrence: null,
      tags: ["ops"],
      warnings: ["INVALID_DATE"]
    });
    expect(inboxHighlightRanges(source, now).map(range => ({
      text: source.slice(range.start, range.end),
      kind: range.kind
    }))).toEqual([
      { text: "Review ", kind: "title" },
      { text: "due 2026-08-01T17:30:00Z", kind: "warning" },
      { text: " ", kind: "title" },
      { text: "#ops", kind: "tag" }
    ]);
  });

  it("avoids common date false positives in ordinary titles", () => {
    expect(parseInboxInput("May release notes for Friday team", now)).toMatchObject({
      title: "May release notes for Friday team",
      dueAt: null
    });
  });
});

describe("normalizeRecurrence", () => {
  it("accepts natural and canonical recurrence values", () => {
    expect(normalizeRecurrence("every 2 weeks")).toBe("RRULE:FREQ=WEEKLY;INTERVAL=2");
    expect(normalizeRecurrence("every 3 days")).toBe("RRULE:FREQ=DAILY;INTERVAL=3");
    expect(normalizeRecurrence("RRULE:FREQ=DAILY;COUNT=5")).toBe("RRULE:FREQ=DAILY;COUNT=5");
  });

  it("rejects invalid or multi-rule values", () => {
    expect(() => normalizeRecurrence("whenever")).toThrow("Invalid recurrence");
    expect(() => normalizeRecurrence("DTSTART:20260801\nRRULE:FREQ=DAILY")).toThrow("Invalid recurrence");
  });
});

describe("inboxHighlightRanges", () => {
  it("returns exact, safe, non-overlapping ranges for every recognized token", () => {
    const source = "Submit report tomorrow at 5pm every weekday #Work #urgent";
    const ranges = inboxHighlightRanges(source, now);

    expect(ranges.map(range => ({
      text: source.slice(range.start, range.end),
      kind: range.kind
    }))).toEqual([
      { text: "Submit report ", kind: "title" },
      { text: "tomorrow at 5pm", kind: "date" },
      { text: " ", kind: "title" },
      { text: "every weekday", kind: "recurrence" },
      { text: " ", kind: "title" },
      { text: "#Work", kind: "tag" },
      { text: " ", kind: "title" },
      { text: "#urgent", kind: "tag" }
    ]);
    expect(ranges.every((range, index) =>
      range.start < range.end
      && (index === 0 || (ranges[index - 1]?.end ?? 0) <= range.start)
    )).toBe(true);
  });

  it("marks malformed recognized-looking syntax as warnings without highlighting quoted syntax", () => {
    const source = 'Keep "due 2026-02-30 #quoted" due 2026-02-30 every blue moon #ops';
    expect(inboxHighlightRanges(source, now).map(range => ({
      text: source.slice(range.start, range.end),
      kind: range.kind
    }))).toEqual([
      { text: 'Keep "due 2026-02-30 #quoted" ', kind: "title" },
      { text: "due 2026-02-30", kind: "warning" },
      { text: " ", kind: "title" },
      { text: "every blue moon", kind: "warning" },
      { text: " ", kind: "title" },
      { text: "#ops", kind: "tag" }
    ]);
  });
});

describe("taskToEditableRawText", () => {
  it("round-trips title, UTC due time, recurrence, and sorted tags without duplicate syntax", () => {
    const rawText = taskToEditableRawText({
      title: "Submit report",
      dueAt: "2026-08-01T17:30:00.000Z",
      recurrence: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
      tags: ["urgent", "work"]
    });

    expect(rawText).toBe(
      "Submit report due 2026-08-01 at 5:30pm RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR #urgent #work"
    );
    expect(parseInboxInput(rawText, now)).toEqual({
      title: "Submit report",
      dueAt: "2026-08-01T17:30:00.000Z",
      recurrence: "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR",
      tags: ["urgent", "work"],
      warnings: []
    });
  });

  it("keeps literal title syntax quoted so editing does not duplicate tokens", () => {
    const rawText = taskToEditableRawText({
      title: "Discuss #launch tomorrow",
      dueAt: null,
      recurrence: null,
      tags: []
    });
    expect(rawText).toBe('"Discuss #launch tomorrow"');
    expect(parseInboxInput(rawText, now).title).toBe("Discuss #launch tomorrow");
  });

  it("preserves literal outer quotes while protecting syntax inside them", () => {
    const title = '"Discuss #launch tomorrow"';
    const rawText = taskToEditableRawText({
      title,
      dueAt: null,
      recurrence: null,
      tags: []
    });

    expect(rawText).toBe('"\\"Discuss #launch tomorrow\\""');
    expect(parseInboxInput(rawText, now)).toMatchObject({
      title,
      dueAt: null,
      recurrence: null,
      tags: []
    });
  });

  it("round-trips canonical due instants without losing seconds or milliseconds", () => {
    const rawText = taskToEditableRawText({
      title: "Timed task",
      dueAt: "2026-08-01T17:30:45.123Z",
      recurrence: null,
      tags: []
    });

    expect(rawText).toBe("Timed task due 2026-08-01T17:30:45.123Z");
    expect(parseInboxInput(rawText, now)).toMatchObject({
      title: "Timed task",
      dueAt: "2026-08-01T17:30:45.123Z"
    });
  });
});
