import { describe, it, expect } from "vitest";
import {
  countPlaceholder,
  escapeHtml,
  normalizeNewlines,
  renderBody,
  renderEmail,
  renderSubject,
  scanTemplate,
} from "./render";

const person = {
  first_name: "Priya",
  company: "Acme Corp",
  link: "https://example.com/webinar?utm=a&utm=b",
  unsubscribe_link: "https://example.com/unsubscribe?u=1&t=2",
};

const linkAnchor =
  '<a href="https://example.com/webinar?utm=a&amp;utm=b">https://example.com/webinar?utm=a&amp;utm=b</a>';
const unsubscribeAnchor =
  '<a href="https://example.com/unsubscribe?u=1&amp;t=2">https://example.com/unsubscribe?u=1&amp;t=2</a>';

const bodyWithSlot = [
  "Hi {{first_name}},",
  "",
  "{{ai_intro}}",
  "",
  "We're hosting a 30-minute webinar on automating warehouse reporting on Oct 28. Register here: {{link}}",
  "",
  "Thanks,",
  "Meera",
  "{{unsubscribe_link}}",
].join("\n");

describe("escapeHtml", () => {
  it("escapes the characters that matter in HTML", () => {
    expect(escapeHtml(`<b>&"'`)).toBe("&lt;b&gt;&amp;&quot;&#39;");
  });

  it("escapes ampersands before the entities they could break", () => {
    expect(escapeHtml("a &amp; b")).toBe("a &amp;amp; b");
  });
});

describe("normalizeNewlines", () => {
  it("turns CRLF and lone CR into LF", () => {
    expect(normalizeNewlines("a\r\nb\rc\nd")).toBe("a\nb\nc\nd");
  });
});

describe("scanTemplate", () => {
  it("collects variables in order, counts occurrences and flags malformed braces", () => {
    const scan = scanTemplate("{{a}} {{b}} {{a}} {{ a }} {oops} {{broken");

    expect(scan.variables).toEqual(["a", "b"]);
    expect(scan.occurrences).toEqual({ a: 3, b: 1 });
    expect(scan.malformed).toEqual(["{{"]);
    expect(scan.invalid).toEqual([]);
  });

  it("keeps names only, with defaults recorded separately", () => {
    const scan = scanTemplate("Hi {{first_name|there}} from {{company|Acme}}");

    expect(scan.variables).toEqual(["first_name", "company"]);
    expect(scan.defaults).toEqual({ first_name: "there", company: "Acme" });
    expect(scan.placeholders.map((p) => p.defaultText)).toEqual(["there", "Acme"]);
  });

  it("marks unusable placeholders as invalid, not as variables", () => {
    const scan = scanTemplate("{{company|}} and {{a|b|c}} and {{bad name}}");

    expect(scan.variables).toEqual([]);
    expect(scan.invalid).toEqual(["company|", "a|b|c", "bad name"]);
  });

  it("accepts names that start with a digit (normalised headers can)", () => {
    expect(scanTemplate("{{2026_sign_up}}").variables).toEqual(["2026_sign_up"]);
  });

  it("flags a default longer than 50 characters as invalid", () => {
    const scan = scanTemplate(`{{company|${"x".repeat(51)}}}`);

    expect(scan.variables).toEqual([]);
    expect(scan.invalid).toHaveLength(1);
  });

  it("counts placeholders case-insensitively, ignoring defaults", () => {
    expect(countPlaceholder("{{AI_INTRO}} and {{ai_intro}}", "ai_intro")).toBe(2);
  });

  it("treats single braces as ordinary text", () => {
    expect(scanTemplate("{hello}").malformed).toEqual([]);
  });
});

describe("renderBody", () => {
  it("substitutes variables, escapes values and converts newlines to <br>", () => {
    const body = renderBody(bodyWithSlot, { ...person, ai_intro: "Since you lead ops, this fits." });

    expect(body).toContain("Hi Priya,");
    expect(body).toContain("Since you lead ops, this fits.");
    expect(body).toContain(linkAnchor);
    expect(body).not.toContain("\n");
    expect(body).toContain("<br>");
  });

  it("escapes raw HTML coming from recipient data instead of injecting it", () => {
    const body = renderBody("Hi {{first_name}}", {
      first_name: `<script>alert("x")</script>`,
    });

    expect(body).toBe("Hi &lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;");
  });

  it("escapes markup written in the template itself (bodies are plain text)", () => {
    expect(renderBody("<b>bold</b>", {})).toBe("&lt;b&gt;bold&lt;/b&gt;");
  });

  it("removes the AI slot line and leaves no blank gap when the intro is empty", () => {
    const body = renderBody(bodyWithSlot, { ...person, ai_intro: undefined });

    expect(body).toBe(
      `Hi Priya,<br><br>We&#39;re hosting a 30-minute webinar on automating warehouse reporting on ` +
        `Oct 28. Register here: ${linkAnchor}<br><br>Thanks,<br>Meera<br>${unsubscribeAnchor}`
    );
    expect(body).not.toContain("<br><br><br>");
  });

  it("treats a whitespace-only intro as empty", () => {
    expect(renderBody("A\n{{ai_intro}}\nB", { ai_intro: "   " })).toBe("A<br>B");
  });

  it("drops a leading slot line without leaving a leading blank line", () => {
    expect(renderBody("{{ai_intro}}\n\nHi {{first_name}}", { first_name: "Raj" })).toBe("Hi Raj");
  });

  it("drops a trailing slot line without leaving a trailing blank line", () => {
    expect(renderBody("Hi {{first_name}}\n\n{{ai_intro}}", { first_name: "Raj" })).toBe("Hi Raj");
  });

  it("removes an inline empty slot without touching the rest of the line", () => {
    expect(renderBody("Hi {{first_name}} {{ai_intro}}there", { first_name: "Raj" })).toBe(
      "Hi Raj there"
    );
  });

  it("accepts the slot with surrounding whitespace and mixed case", () => {
    expect(renderBody("A\n{{ ai_intro }}\nB", { ai_intro: "" })).toBe("A<br>B");
    expect(renderBody("A\n{{AI_INTRO}}\nB", { AI_intro: "hey" })).toBe("A<br>hey<br>B");
  });

  it("keeps the user's own paragraph spacing when the intro is present", () => {
    expect(renderBody("A\n\n\nB", {})).toBe("A<br><br><br>B");
  });

  it("matches variable names case-insensitively (CSV headers are)", () => {
    expect(renderBody("Hi {{First_Name}}", { first_name: "Priya" })).toBe("Hi Priya");
  });

  describe("defaults", () => {
    it("uses the default when the value is missing or blank", () => {
      expect(renderBody("Hi {{first_name|there}}", {})).toBe("Hi there");
      expect(renderBody("Hi {{first_name|there}}", { first_name: "" })).toBe("Hi there");
      expect(renderBody("Hi {{first_name|there}}", { first_name: "   " })).toBe("Hi there");
    });

    it("prefers the value when there is one", () => {
      expect(renderBody("Hi {{first_name|there}}", { first_name: "Priya" })).toBe("Hi Priya");
    });

    it("escapes the default text like any other text", () => {
      expect(renderBody("Hi {{first_name|<b>there</b>}}", {})).toBe(
        "Hi &lt;b&gt;there&lt;/b&gt;"
      );
    });

    it("trims the default and tolerates spaces around the pipe", () => {
      expect(renderBody("{{company | Acme Corp }}", {})).toBe("Acme Corp");
    });

    it("supports defaults in the subject too", () => {
      expect(renderSubject("Invite for {{company|your team}}", {})).toBe("Invite for your team");
    });
  });

  describe("line endings", () => {
    it("normalises CRLF so no carriage return survives", () => {
      const body = renderBody("Hi {{first_name}},\r\n\r\n{{ai_intro}}\r\n\r\nBye", {
        first_name: "Raj",
      });

      expect(body).toBe("Hi Raj,<br><br>Bye");
      expect(body).not.toContain("\r");
    });

    it("normalises lone CR line endings", () => {
      const body = renderBody("A\rB\r{{ai_intro}}\rC", {});

      expect(body).toBe("A<br>B<br>C");
      expect(body).not.toContain("\r");
    });

    it("normalises CRLF in the subject", () => {
      expect(renderSubject("Invite\r\nfor {{company}}", { company: "Acme" })).toBe(
        "Invite for Acme"
      );
    });

    it("removes the slot line in a CRLF template without leaving a blank gap", () => {
      const body = renderBody("Hi,\r\n\r\n{{ai_intro}}\r\n\r\nBye", {});

      expect(body).toBe("Hi,<br><br>Bye");
      expect(body).not.toContain("<br><br><br>");
    });
  });

  describe("link anchors", () => {
    it("renders link and unsubscribe_link as anchors with the escaped URL in href and text", () => {
      const body = renderBody("{{link}} {{unsubscribe_link}}", person);

      expect(body).toBe(`${linkAnchor} ${unsubscribeAnchor}`);
      expect(body).toContain('href="https://example.com/webinar?utm=a&amp;utm=b"');
      expect(body).not.toContain("&utm=b\""); // the raw & must be escaped in the attribute
    });

    it("does not anchor any other variable", () => {
      expect(
        renderBody("{{company}}", { company: "https://example.com/?a=1&b=2" })
      ).toBe("https://example.com/?a=1&amp;b=2");
    });

    it("stays plain escaped text when the link value is not an http(s) URL", () => {
      expect(renderBody("{{link}}", { link: "javascript:alert(1)" })).toBe(
        "javascript:alert(1)"
      );
      expect(renderBody("{{link}}", { link: "" })).toBe("");
    });

    it("stays plain escaped text in the subject", () => {
      expect(renderSubject("Read {{link}}", person)).toBe(
        "Read https://example.com/webinar?utm=a&utm=b"
      );
    });
  });

  it("renders a variable the recipient has no value for as empty text", () => {
    expect(renderBody("Hi {{first_name}}!", {})).toBe("Hi !");
    expect(renderBody("Hi {{first_name}}!", { first_name: "" })).toBe("Hi !");
    expect(renderBody("Hi {{first_name}}!", { first_name: undefined })).toBe("Hi !");
  });

  it("never leaves an unresolved placeholder behind", () => {
    const body = renderBody("Hi {{first_name}}, {{city}}!", { first_name: "Ana" });

    expect(body).toBe("Hi Ana, !");
    expect(body).not.toContain("{ {");
    expect(body).not.toContain("{{");
  });
});

describe("renderSubject", () => {
  it("does not HTML-escape the subject (it is a header, not markup)", () => {
    expect(renderSubject("Q&A for {{company}}", { company: "Acme & Co" })).toBe("Q&A for Acme & Co");
  });

  it("flattens newlines from values so they cannot inject headers", () => {
    expect(renderSubject("Invite {{company}}", { company: "Acme\r\nBcc: evil@x.com" })).toBe(
      "Invite Acme Bcc: evil@x.com"
    );
  });

  it("collapses runs of whitespace and trims", () => {
    expect(renderSubject("  Invite   {{company}}  ", { company: "Acme" })).toBe("Invite Acme");
  });
});

describe("regex timing", () => {
  it("scans a template of {{a| plus 20,000 spaces in well under 100ms", () => {
    // No closing }}: the {{ is malformed, not an invalid group.
    const template = "{{a|" + " ".repeat(20_000);
    const start = performance.now();
    const scan = scanTemplate(template);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(scan.variables).toEqual([]);
    expect(scan.malformed).toEqual(["{{"]);
  });

  it("scans {{a| repeated 5,000 times in well under 100ms", () => {
    const template = ("{{a|" as string).repeat(5_000);
    const start = performance.now();
    const scan = scanTemplate(template);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    expect(scan.variables).toEqual([]);
    expect(scan.placeholders).toHaveLength(0);
  });

  it("scans 20,000 {{ repetitions in well under 100ms", () => {
    const template = "{{ ".repeat(20_000);
    const start = performance.now();
    const scan = scanTemplate(template);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
  });
});

describe("scanTemplate with prototype-shaped names", () => {
  // Placeholder names are untrusted (they come from CSV headers). Using
  // Object.create(null) in scanTemplate means keys like "constructor",
  // "toString" and "__proto__" are ordinary properties, not prototype lookups.

  function occ(map: Array<[string, number]>): Record<string, number> {
    const obj = Object.create(null) as Record<string, number>;
    for (const [k, v] of map) obj[k] = v;
    return obj;
  }

  it("handles {{constructor}} without throwing or miscounting", () => {
    const scan = scanTemplate("{{constructor}}");
    expect(scan.variables).toEqual(["constructor"]);
    expect(scan.occurrences).toEqual(occ([["constructor", 1]]));
    expect(renderBody("Hi {{constructor}}", { constructor: "safe" })).toBe("Hi safe");
  });

  it("handles {{toString}} without throwing or miscounting", () => {
    const scan = scanTemplate("{{toString}}");
    expect(scan.variables).toEqual(["toString"]);
    // Variable names are lowercased for case-insensitive matching.
    expect(scan.occurrences).toEqual(occ([["tostring", 1]]));
    expect(renderBody("Hi {{toString}}", { toString: "safe" })).toBe("Hi safe");
  });

  it("handles {{__proto__}} without throwing or miscounting", () => {
    const scan = scanTemplate("{{__proto__}}");
    expect(scan.variables).toEqual(["__proto__"]);
    expect(scan.occurrences).toEqual(occ([["__proto__", 1]]));
    // Build the values map with Object.create(null) and direct assignment so
    // __proto__ is an own property, not a prototype mutation.
    const values = Object.create(null) as Record<string, string>;
    values.__proto__ = "safe";
    expect(renderBody("Hi {{__proto__}}", values)).toBe("Hi safe");
  });
});


describe("renderBody normalizes newlines in substituted values", () => {
  it("removes CRLF from a CSV value so no carriage return survives in the output", () => {
    const body = renderBody("Hi {{first_name}}, bye", {
      first_name: "Raj\r\nExtra",
    });
    expect(body).not.toContain("\r");
    expect(body).toBe("Hi Raj<br>Extra, bye");
  });

  it("normalises lone CR in a value", () => {
    const body = renderBody("Hi {{first_name}}", { first_name: "A\rB" });
    expect(body).not.toContain("\r");
    expect(body).toBe("Hi A<br>B");
  });
});

describe("renderEmail", () => {
  it("renders the approved sample from the spec (section 3) for a rich-data recipient", () => {
    const { subject, body } = renderEmail({
      subjectTemplate: "Invitation: Ops Automation Webinar, Oct 28",
      bodyTemplate: bodyWithSlot,
      values: { ...person, ai_intro: "Since you lead operations at Acme Corp, this should be relevant." },
    });

    expect(subject).toBe("Invitation: Ops Automation Webinar, Oct 28");
    expect(body).toContain("Hi Priya,");
    expect(body).toContain("Since you lead operations at Acme Corp, this should be relevant.");
    expect(body).toContain(linkAnchor);
  });

  it("renders the thin-data recipient with the slot removed and no gap", () => {
    const { body } = renderEmail({
      subjectTemplate: "Invitation",
      bodyTemplate: bodyWithSlot,
      values: { ...person, first_name: "Raj", ai_intro: undefined },
    });

    expect(body).not.toContain("{{");
    expect(body).not.toContain("<br><br><br>");
    expect(body.startsWith("Hi Raj,<br><br>We&#39;re hosting")).toBe(true);
  });
});
