/**
 * Email HTML Templates
 * Generates clean, branded HTML email bodies without emojis.
 */

/**
 * 1. OTP Email HTML Template (Signup / Verification)
 *
 * @param {string} otp   - The 6-digit OTP code
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
    `-- The OpenHW Studio Team`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OpenHW Studio - Verify your email</title>
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
                OpenHW Studio
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
                Use the verification code below to complete your verification. The code is valid
                for <strong style="color:#f1f5f9;">10 minutes</strong>.
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
                If you did not make this request, you can safely ignore this email.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="border-top:1px solid #334155;padding:20px 32px;text-align:center;">
              <p style="margin:0;font-size:12px;color:#475569;">
                (C) ${new Date().getFullYear()} OpenHW Studio | FOSSEE, IIT Bombay
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

/**
 * 2. Account Deletion OTP Email Template (Step 1 Confirmation)
 *
 * @param {string} otp          - The 6-digit OTP code
 * @param {string} name         - Recipient's name
 * @param {string} deletionDate - Formatted date string (30 days from now)
 * @returns {object}            - { subject, message, html }
 */
export function buildDeletionOtpEmail(otp, name = 'there', deletionDate = '') {
  const subject = 'Confirm Your OpenHW Studio Account Deletion';

  const message =
    `Hi ${name},\n\n` +
    `We received a request to delete your OpenHW Studio account.\n\n` +
    `Enter this 6-digit code to confirm account deletion:\n\n` +
    `  ${otp}\n\n` +
    `This code expires in 10 minutes.\n\n` +
    `Once confirmed, your account will enter a 30-day grace period and will be permanently deleted on ${deletionDate}.\n` +
    `You can cancel the deletion at any time before that date simply by logging back in.\n\n` +
    `If you did not request this, please ignore this email and change your password immediately.\n\n` +
    `-- The OpenHW Studio Team`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OpenHW Studio - Confirm Account Deletion</title>
</head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0"
          style="background:#1e293b;border-radius:12px;border:1px solid #7f1d1d;overflow:hidden;max-width:520px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#b91c1c,#7f1d1d);padding:28px 32px;text-align:center;">
              <h1 style="margin:0;font-size:22px;color:#ffffff;letter-spacing:1px;font-weight:700;">
                Account Deletion Request
              </h1>
              <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,0.75);letter-spacing:2px;text-transform:uppercase;">
                OpenHW Studio
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 32px;">
              <p style="margin:0 0 20px;font-size:15px;color:#cbd5e1;">
                Hi <strong style="color:#f1f5f9;">${name}</strong>,
              </p>
              <p style="margin:0 0 20px;font-size:15px;color:#94a3b8;line-height:1.7;">
                We received a request to permanently delete your OpenHW Studio account.
                Enter the code below to confirm this request. The code is valid for <strong style="color:#f1f5f9;">10 minutes</strong>.
              </p>

              <!-- OTP Box -->
              <div style="background:#0f172a;border:1px solid #7f1d1d;border-radius:10px;padding:28px;text-align:center;margin-bottom:28px;">
                <p style="margin:0 0 8px;font-size:11px;color:#6b7280;letter-spacing:3px;text-transform:uppercase;">
                  Deletion Confirmation Code
                </p>
                <p style="margin:0;font-size:44px;font-weight:800;letter-spacing:14px;color:#f87171;font-family:monospace;">
                  ${otp}
                </p>
              </div>

              <!-- Warning Box -->
              <div style="background:#1c0a0a;border:1px solid #7f1d1d;border-radius:8px;padding:16px 20px;margin-bottom:20px;">
                <p style="margin:0;font-size:13px;color:#fca5a5;line-height:1.7;">
                  <strong>Important Notice:</strong><br/>
                  - Your account will be deactivated immediately.<br/>
                  - All personal data will be permanently deleted on <strong>${deletionDate}</strong>.<br/>
                  - You can cancel this deletion anytime before that date by logging in.
                </p>
              </div>

              <p style="margin:0;font-size:13px;color:#475569;line-height:1.6;">
                If you did not request this, please ignore this email. Your account remains safe.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="border-top:1px solid #334155;padding:20px 32px;text-align:center;">
              <p style="margin:0;font-size:12px;color:#475569;">
                (C) ${new Date().getFullYear()} OpenHW Studio | FOSSEE, IIT Bombay
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

/**
 * 3. Deletion Scheduled Confirmation Email (Sent immediately upon OTP verification)
 *
 * @param {string} name         - Recipient's name
 * @param {string} deletionDate - Formatted date string (30 days from now)
 * @returns {object}            - { subject, message, html }
 */
export function buildDeletionScheduledEmail(name = 'there', deletionDate = '') {
  const subject = 'Your OpenHW Studio Account Is Scheduled for Deletion';

  const message =
    `Hi ${name},\n\n` +
    `Your request to delete your OpenHW Studio account has been confirmed.\n\n` +
    `Your account has now been deactivated and entered a 30-day grace period.\n` +
    `Permanent deletion date: ${deletionDate}\n\n` +
    `What will happen:\n` +
    `- All personal data (name, email, password, login credentials) will be permanently wiped on ${deletionDate}.\n` +
    `- All personal projects, gamification stats, and progress will be deleted.\n` +
    `- Academic records (classroom submissions or teacher courses) will be preserved in anonymized form.\n\n` +
    `Changed your mind?\n` +
    `You can cancel the deletion and restore your account at any time before ${deletionDate} simply by logging in to OpenHW Studio.\n\n` +
    `-- The OpenHW Studio Team`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OpenHW Studio - Account Scheduled for Deletion</title>
</head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0"
          style="background:#1e293b;border-radius:12px;border:1px solid #334155;overflow:hidden;max-width:520px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#334155,#1e293b);padding:28px 32px;text-align:center;border-bottom:1px solid #475569;">
              <h1 style="margin:0;font-size:22px;color:#ffffff;letter-spacing:1px;font-weight:700;">
                Account Deactivation Notice
              </h1>
              <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,0.75);letter-spacing:2px;text-transform:uppercase;">
                30-Day Grace Period Initiated
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 32px;">
              <p style="margin:0 0 20px;font-size:15px;color:#cbd5e1;">
                Hi <strong style="color:#f1f5f9;">${name}</strong>,
              </p>
              <p style="margin:0 0 20px;font-size:15px;color:#94a3b8;line-height:1.7;">
                Your request to delete your OpenHW Studio account has been confirmed. Your account is now deactivated.
              </p>

              <!-- Date Box -->
              <div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:20px;text-align:center;margin-bottom:24px;">
                <p style="margin:0 0 6px;font-size:11px;color:#64748b;letter-spacing:2px;text-transform:uppercase;">
                  Scheduled Permanent Deletion Date
                </p>
                <p style="margin:0;font-size:20px;font-weight:700;color:#f87171;font-family:monospace;">
                  ${deletionDate}
                </p>
              </div>

              <div style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:18px 20px;margin-bottom:24px;">
                <p style="margin:0 0 10px;font-size:13px;color:#f1f5f9;font-weight:600;">
                  What will be deleted on ${deletionDate}:
                </p>
                <ul style="margin:0;padding:0 0 0 18px;color:#94a3b8;font-size:13px;line-height:1.8;">
                  <li>Name, email address, password, and profile data</li>
                  <li>Personal simulation projects and saved circuits</li>
                  <li>XP, levels, badges, streaks, and progress records</li>
                </ul>
                <p style="margin:12px 0 0;font-size:12px;color:#64748b;line-height:1.6;">
                  Academic records (coursework submissions and class records) will remain preserved in an anonymized format.
                </p>
              </div>

              <!-- Reactivation note -->
              <div style="background:#06281e;border:1px solid #065f46;border-radius:8px;padding:16px 20px;margin-bottom:20px;">
                <p style="margin:0;font-size:13px;color:#6ee7b7;line-height:1.6;">
                  <strong>How to reactivate your account:</strong><br/>
                  If you change your mind, log in to OpenHW Studio anytime before <strong>${deletionDate}</strong> and select <em>Reactivate Account</em>.
                </p>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="border-top:1px solid #334155;padding:20px 32px;text-align:center;">
              <p style="margin:0;font-size:12px;color:#475569;">
                (C) ${new Date().getFullYear()} OpenHW Studio | FOSSEE, IIT Bombay
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

/**
 * 4. Deletion Reminder Email (Sent 1 day / 24 hours prior to permanent deletion)
 *
 * @param {string} name         - Recipient's name
 * @param {string} deletionDate - Formatted date string
 * @returns {object}            - { subject, message, html }
 */
export function buildDeletionReminderEmail(name = 'there', deletionDate = '') {
  const subject = 'Reminder: Your OpenHW Studio Account Will Be Deleted in 24 Hours';

  const message =
    `Hi ${name},\n\n` +
    `This is a final reminder that your OpenHW Studio account is scheduled to be permanently deleted in 24 hours on ${deletionDate}.\n\n` +
    `Once deleted, your personal profile, projects, and data cannot be recovered.\n\n` +
    `If you wish to keep your account, please log in now to cancel the deletion request.\n\n` +
    `-- The OpenHW Studio Team`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OpenHW Studio - Final Deletion Reminder</title>
</head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0"
          style="background:#1e293b;border-radius:12px;border:1px solid #7f1d1d;overflow:hidden;max-width:520px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#b91c1c,#7f1d1d);padding:28px 32px;text-align:center;">
              <h1 style="margin:0;font-size:22px;color:#ffffff;letter-spacing:1px;font-weight:700;">
                Final Deletion Reminder
              </h1>
              <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,0.75);letter-spacing:2px;text-transform:uppercase;">
                24 Hours Remaining
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 32px;">
              <p style="margin:0 0 20px;font-size:15px;color:#cbd5e1;">
                Hi <strong style="color:#f1f5f9;">${name}</strong>,
              </p>
              <p style="margin:0 0 20px;font-size:15px;color:#94a3b8;line-height:1.7;">
                This is a final reminder that your OpenHW Studio account is scheduled to be permanently deleted on
                <strong style="color:#f87171;"> ${deletionDate}</strong> (within 24 hours).
              </p>

              <!-- Warning Box -->
              <div style="background:#1c0a0a;border:1px solid #7f1d1d;border-radius:8px;padding:16px 20px;margin-bottom:24px;">
                <p style="margin:0;font-size:13px;color:#fca5a5;line-height:1.7;">
                  <strong>Action Required if you wish to keep your account:</strong><br/>
                  After ${deletionDate}, all personal data, saved circuits, and progress will be permanently erased and cannot be restored.
                </p>
              </div>

              <!-- Reactivate button / link instructions -->
              <div style="background:#06281e;border:1px solid #065f46;border-radius:8px;padding:16px 20px;margin-bottom:20px;">
                <p style="margin:0;font-size:13px;color:#6ee7b7;line-height:1.6;">
                  To keep your account, simply log in to OpenHW Studio before ${deletionDate} and confirm reactivation.
                </p>
              </div>

              <p style="margin:0;font-size:13px;color:#475569;line-height:1.6;">
                If you still wish to delete your account, no further action is needed. Your data will be wiped automatically.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="border-top:1px solid #334155;padding:20px 32px;text-align:center;">
              <p style="margin:0;font-size:12px;color:#475569;">
                (C) ${new Date().getFullYear()} OpenHW Studio | FOSSEE, IIT Bombay
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

/**
 * 5. Deletion Completed Confirmation Email (Sent after permanent purge)
 *
 * @param {string} name - Recipient's name
 * @returns {object}    - { subject, message, html }
 */
export function buildDeletionCompletedEmail(name = 'there') {
  const subject = 'Your OpenHW Studio Account Has Been Deleted';

  const message =
    `Hi ${name},\n\n` +
    `Your OpenHW Studio account and all associated personal data have now been permanently deleted in accordance with your request.\n\n` +
    `Thank you for having been a part of OpenHW Studio. If you ever wish to use OpenHW Studio again in the future, you are welcome to create a new account at any time.\n\n` +
    `-- The OpenHW Studio Team`;

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>OpenHW Studio - Account Deleted</title>
</head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0"
          style="background:#1e293b;border-radius:12px;border:1px solid #334155;overflow:hidden;max-width:520px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#334155,#1e293b);padding:28px 32px;text-align:center;border-bottom:1px solid #475569;">
              <h1 style="margin:0;font-size:22px;color:#ffffff;letter-spacing:1px;font-weight:700;">
                Account Deletion Completed
              </h1>
              <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,0.75);letter-spacing:2px;text-transform:uppercase;">
                OpenHW Studio
              </p>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:36px 32px;">
              <p style="margin:0 0 20px;font-size:15px;color:#cbd5e1;">
                Hi <strong style="color:#f1f5f9;">${name}</strong>,
              </p>
              <p style="margin:0 0 20px;font-size:15px;color:#94a3b8;line-height:1.7;">
                Your OpenHW Studio account and all associated personal data have now been permanently deleted in accordance with your request.
              </p>

              <div style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:18px 20px;margin-bottom:24px;">
                <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.7;">
                  All login credentials, saved circuits, and progress records have been removed from our servers.
                </p>
              </div>

              <p style="margin:0;font-size:14px;color:#cbd5e1;line-height:1.6;">
                Thank you for having been a part of OpenHW Studio. If you wish to use the simulator again in the future, you are always welcome to register a new account.
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="border-top:1px solid #334155;padding:20px 32px;text-align:center;">
              <p style="margin:0;font-size:12px;color:#475569;">
                (C) ${new Date().getFullYear()} OpenHW Studio | FOSSEE, IIT Bombay
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
