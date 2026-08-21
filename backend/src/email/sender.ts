import nodemailer from "nodemailer";
import { getEtherealTransporter } from "./transporter";

export interface SendEmailResult {
  success: boolean;
  messageId?: string;
  etherealUrl?: string;
  error?: string;
}

/**
 * Send a single email via Ethereal SMTP.
 * Returns the result including an Ethereal preview URL.
 */
export async function sendEmail(
  to: string,
  subject: string,
  body: string,
  from?: string
): Promise<SendEmailResult> {
  try {
    const { transporter } = await getEtherealTransporter();

    const info = await transporter.sendMail({
      from: from || '"Sendly" <noreply@sendly.local>',
      to,
      subject,
      html: body,
    });

    // Ethereal provides a preview URL to see the email
    const etherealUrl = nodemailer.getTestMessageUrl(info);

    console.log(
      `[Email] Sent to ${to} — messageId: ${info.messageId} ${
        etherealUrl ? `preview: ${etherealUrl}` : ""
      }`
    );

    return {
      success: true,
      messageId: info.messageId,
      etherealUrl: etherealUrl || undefined,
    };
  } catch (error: any) {
    console.error(`[Email] Failed to send to ${to}:`, error.message);
    return {
      success: false,
      error: error.message,
    };
  }
}
