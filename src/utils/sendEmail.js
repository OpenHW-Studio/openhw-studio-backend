import nodemailer from 'nodemailer';

/**
 * Send an email using configured SMTP credentials.
 * 
 * In development (when SMTP_HOST / SMTP_EMAIL is not set),
 * the email is NOT sent — instead the full content is printed
 * to the terminal console so OTPs can be copied without any
 * mail-server setup.
 *
 * Options:
 *   email   {string}  Recipient address
 *   subject {string}  Email subject line
 *   message {string}  Plain-text body (required)
 *   html    {string}  HTML body (optional, falls back to message)
 */
const sendEmail = async (options) => {
  const smtpConfigured =
    process.env.SMTP_HOST &&
    process.env.SMTP_EMAIL &&
    process.env.SMTP_PASSWORD;

  // ── Development / No-SMTP Fallback ─────────────────────────────────────
  if (!smtpConfigured) {
    console.log('\n╔══════════════════════════════════════════════╗');
    console.log('║        [DEV EMAIL — NOT ACTUALLY SENT]       ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║  To      : ${options.email}`);
    console.log(`║  Subject : ${options.subject}`);
    console.log('╠══════════════════════════════════════════════╣');
    console.log(options.message || options.html || '(no body)');
    console.log('╚══════════════════════════════════════════════╝\n');
    return;
  }

  // ── Production / Real SMTP ──────────────────────────────────────────────
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: Number(process.env.SMTP_PORT) === 465, // true only for port 465 (SSL)
    auth: {
      user: process.env.SMTP_EMAIL,
      pass: process.env.SMTP_PASSWORD,
    },
  });

  const message = {
    from: `${process.env.FROM_NAME || 'OpenHW Studio'} <${process.env.FROM_EMAIL || process.env.SMTP_EMAIL}>`,
    to: options.email,
    subject: options.subject,
    text: options.message,
    ...(options.html && { html: options.html }),
  };

  const info = await transporter.sendMail(message);
  console.log(`[Email] Sent to ${options.email} — messageId: ${info.messageId}`);
};

export default sendEmail;

