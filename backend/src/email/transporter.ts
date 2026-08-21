import nodemailer from "nodemailer";

/**
 * Creates and returns an Ethereal Email test account + transporter.
 * Caches the transporter globally so we only create one account per server start.
 */
let cachedTransporter: nodemailer.Transporter | null = null;
let cachedEtherealUser: string | null = null;

export async function getEtherealTransporter(): Promise<{
  transporter: nodemailer.Transporter;
  user: string;
}> {
  if (cachedTransporter && cachedEtherealUser) {
    return { transporter: cachedTransporter, user: cachedEtherealUser };
  }

  // Create a test account at ethereal.email
  const testAccount = await nodemailer.createTestAccount();

  const transporter = nodemailer.createTransport({
    host: "smtp.ethereal.email",
    port: 587,
    secure: false,
    auth: {
      user: testAccount.user,
      pass: testAccount.pass,
    },
  });

  cachedTransporter = transporter;
  cachedEtherealUser = testAccount.user;

  console.log(
    `[Ethereal] Created test account: ${testAccount.user} (web: https://ethereal.email/login)`
  );

  return { transporter, user: testAccount.user };
}

/**
 * Get list of configured sender emails (from env or generate Ethereal accounts).
 * For simplicity, we use the same ethereal account as the sender.
 */
export async function getSenderEmails(): Promise<string[]> {
  const { user } = await getEtherealTransporter();
  return [user];
}
