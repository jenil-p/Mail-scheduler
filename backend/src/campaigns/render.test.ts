import { describe, it, expect } from "vitest";
import {
  countPlaceholder,
  escapeHtml,
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

describe("scanTemplate", () => {
  it("collects variables in order, counts occurrences and flags malformed braces", () => {
    const scan = scanTemplate("{{a}} {{b}} {{a}} {{ a }} {oops} {{broken");

    expect(scan.variables).toEqual(["a", "b"]);
    expect(scan.occurrences).toEqual({ a: 3, b: 1 });
    expect(scan.malformed).toEqual(["{{"]);
  });

  it("counts placeholders case-insensitively", () => {
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
    expect(body).toContain("&amp;utm=b");
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
      "Hi Priya,<br><br>" +
        "We&#39;re hosting a 30-minute webinar on automating warehouse reporting on Oct 28. " +
        "Register here: https://example.com/webinar?utm=a&amp;utm=b<br><br>" +
        "Thanks,<br>Meera<br>https://example.com/unsubscribe?u=1&amp;t=2"
    );
    expect(body).not.toContain("<br><br><br>");
  });

  it("treats a whitespace-only intro as empty", () => {
    const body = renderBody("A\n{{ai_intro}}\nB", { ai_intro: "   " });

    expect(body).toBe("A<br>B");
  });

  it("drops a leading slot line without leaving a leading blank line", () => {
    expect(renderBody("{{ai_intro}}\n\nHi {{first_name}}", { first_name: "Raj" })).toBe("Hi Raj");
  });

  it("drops a trailing slot line without leaving a trailing blank line", () => {
    expect(renderBody("Hi {{first_name}}\n\n{{ai_intro}}", { first_name: "Raj" })).toBe("Hi Raj");
  });

  it("removes an inline empty slot without touching the rest of the line", () => {
    expect(renderBody("Hi {{first_name}} {{ai_intro}}there", { first_name: "Raj" })).toBe("Hi Raj there");
  });

  it("accepts the slot with surrounding whitespace and mixed case", () => {
    expect(renderBody("A\n{{ ai_intro }}\nB", { ai_intro: "" })).toBe("A<br>B");
    expect(renderBody("A\n{{AI_INTRO}}\nB", { AI_intro: "hey" })).toBe("A<br>hey<br>B");
  });

  it("keeps the user's own paragraph spacing when the intro is present", () => {
    const body = renderBody("A\n\n\nB", {});

    expect(body).toBe("A<br><br><br>B");
  });

  it("matches variable names case-insensitively (CSV headers are)", () => {
    expect(renderBody("Hi {{First_Name}}", { first_name: "Priya" })).toBe("Hi Priya");
  });

  it("renders a variable the recipient has no value for as empty text", () => {
    expect(renderBody("Hi {{first_name}}!", {})).toBe("Hi !");
    expect(renderBody("Hi {{first_name}}!", { first_name: "" })).toBe("Hi !");
    expect(renderBody("Hi {{first_name}}!", { first_name: undefined })).toBe("Hi !");
  });

  it("never leaves an unresolved placeholder behind", () => {
    const body = renderBody("Hi {{first_name}}, {{city}}!", { first_name: "Ana" });

    expect(body).toBe("Hi Ana, !");
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
    expect(body).toContain("Thanks,");
  });

  it("renders the thin-data recipient with the slot removed and no gap", () => {
    const { body } = renderEmail({
      subjectTemplate: "Invitation",
      bodyTemplate: bodyWithSlot,
      values: { first_name: "Raj", link: "https://example.com/x", unsubscribe_link: "https://example.com/u", ai_intro: undefined },
    });

    expect(body).not.toContain("{{");
    expect(body).not.toContain("<br><br><br>");
    expect(body.startsWith("Hi Raj,<br><br>We&#39;re hosting")).toBe(true);
  });
});
