import { describe, expect, it } from "vitest";
import { normalizeRecurrence, parseInboxInput } from "./parser.js";

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
