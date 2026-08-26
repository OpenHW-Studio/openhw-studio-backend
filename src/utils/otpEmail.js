/**
 * OTP Email HTML Template
 * Generates a clean, branded HTML email body for verification codes.
 *
 * @param {string} otp   - The 6-digit OTP code to embed
 * @param {string} name  - Recipient's name (optional, defaults to "there")
 * @returns {object}     - { subject, message, html }
 */
export function buildOtpEmail(otp, name = 'there') {
  const subject = 'Your OpenHW Studio Verification Code';

  const message =
    `Hi ${name},\n\n` +
    `Your email verification code for OpenHW Studio is:\n\n` +
    `  ${otp}\n\n` +
    `This code expires in 10 minutes. Do not share it with anyone.\n\n` +
    `If you did not request this, please ignore this email.\n\n` +
    `— The OpenHW Studio Team`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OpenHW Studio — Verify your email</title>
</head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0"
          style="background:#1e293b;border-radius:12px;border:1px solid #334155;overflow:hidden;max-width:520px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#0ea5e9,#6366f1);padding:28px 32px;text-align:center;">
              <h1 style="margin:0;font-size:22px;color:#ffffff;letter-spacing:1px;font-weight:700;">
                ⚡ OpenHW Studio
              </h1>
              <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,0.75);letter-spacing:2px;text-transform:uppercase;">
                Email Verification
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 32px;">
              <p style="margin:0 0 20px;font-size:15px;color:#cbd5e1;">
                Hi <strong style="color:#f1f5f9;">${name}</strong>,
              </p>
              <p style="margin:0 0 28px;font-size:15px;color:#94a3b8;line-height:1.7;">
                Use the verification code below to complete your sign-up. The code is valid
                for&nbsp;<strong style="color:#f1f5f9;">10 minutes</strong>.
              </p>

              <!-- OTP Box -->
              <div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:28px;text-align:center;margin-bottom:28px;">
                <p style="margin:0 0 8px;font-size:11px;color:#475569;letter-spacing:3px;text-transform:uppercase;">
                  Your Verification Code
                </p>
                <p style="margin:0;font-size:44px;font-weight:800;letter-spacing:14px;color:#38bdf8;font-family:monospace;">
                  ${otp}
                </p>
              </div>

              <p style="margin:0;font-size:13px;color:#475569;line-height:1.6;">
                If you did not create an account with OpenHW Studio, you can safely ignore this email —
                no account will be created.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="border-top:1px solid #334155;padding:20px 32px;text-align:center;">
              <p style="margin:0;font-size:12px;color:#475569;">
                © ${new Date().getFullYear()} OpenHW Studio &nbsp;|&nbsp; FOSSEE, IIT Bombay
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `.trim();

  return { subject, message, html };
}
