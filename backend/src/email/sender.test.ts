import { describe, expect, it, vi, beforeEach } from "vitest";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import nodemailer from "nodemailer";

const require = createRequire(import.meta.url);

/**
 * Locate nodemailer's own package.json. nodemailer 10 does not expose
 * `./package.json` through its exports map, so resolve the entry point first
 * and walk up to the package root instead of requiring the subpath.
 */
function resolveNodemailerPackageJson(): string {
  let dir = path.dirname(require.resolve("nodemailer"));
  for (;;) {
    const candidate = path.join(dir, "package.json");
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, "utf8"));
      if (pkg.name === "nodemailer") return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error("nodemailer package.json not found");
    dir = parent;
  }
}

const installedVersion: string = JSON.parse(
  readFileSync(resolveNodemailerPackageJson(), "utf8")
).version;

describe("nodemailer runtime used by the email transport", () => {
  it("uses the nodemailer 10 API generation", () => {
    expect(Number(installedVersion.split(".")[0])).toBeGreaterThanOrEqual(10);
  });

  it("exposes the transport helpers the email modules import", () => {
    expect(typeof nodemailer.createTransport).toBe("function");
    expect(typeof nodemailer.createTestAccount).toBe("function");
    expect(typeof nodemailer.getTestMessageUrl).toBe("function");
  });

  it("resolves an Ethereal preview URL from a sendMail response", () => {
    const url = nodemailer.getTestMessageUrl({
      response: "250 Accepted [STATUS=new MSGID=preview-id.synthetic]",
    });

    expect(url).toBeTruthy();
    expect(String(url)).toContain("preview-id.synthetic");
  });
});

vi.mock("./transporter", () => ({
  getEtherealTransporter: vi.fn(),
}));

const { getEtherealTransporter } = await import("./transporter");
const { sendEmail } = await import("./sender");

describe("sendEmail", () => {
  beforeEach(() => {
    vi.mocked(getEtherealTransporter).mockReset();
  });

  it("sends the html body through the cached transporter and returns its message id", async () => {
    const sendMail = vi.fn().mockResolvedValue({
      messageId: "<synthetic@sendly.local>",
      response: "250 Accepted [STATUS=new MSGID=preview-id.synthetic]",
    });

    vi.mocked(getEtherealTransporter).mockResolvedValue({
      transporter: { sendMail } as any,
      user: "sender@example.test",
    });

    const result = await sendEmail(
      "recipient@example.test",
      "Hello",
      "<p>Body</p>",
      "Sendly <sender@example.test>"
    );

    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledWith({
      from: "Sendly <sender@example.test>",
      to: "recipient@example.test",
      subject: "Hello",
      html: "<p>Body</p>",
    });
    expect(result).toMatchObject({
      success: true,
      messageId: "<synthetic@sendly.local>",
    });
    expect(result.etherealUrl).toContain("preview-id.synthetic");
  });

  it("falls back to the default sender and reports send failures", async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error("smtp unavailable"));

    vi.mocked(getEtherealTransporter).mockResolvedValue({
      transporter: { sendMail } as any,
      user: "sender@example.test",
    });

    const result = await sendEmail("recipient@example.test", "Hi", "<p>Hi</p>");

    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: '"Sendly" <noreply@sendly.local>' })
    );
    expect(result).toEqual({ success: false, error: "smtp unavailable" });
  });
});
