/**
 * User Administration Email Templates
 * Branded HTML email notifications for administrative user state updates:
 * - Role Change
 * - Account Suspension
 * - Account Unsuspension / Restoration
 * - Account Blocking
 * - Account Unblocking
 * - Permanent Account Deletion
 */

const baseEmailWrapper = (title, headerSubtitle, contentHtml, accentColor = '#0ea5e9') => `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
</head>
<body style="margin:0;padding:0;background:#0f172a;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0f172a;padding:40px 16px;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0"
          style="background:#1e293b;border-radius:12px;border:1px solid #334155;overflow:hidden;max-width:520px;width:100%;">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,${accentColor},#6366f1);padding:28px 32px;text-align:center;">
              <h1 style="margin:0;font-size:22px;color:#ffffff;letter-spacing:1px;font-weight:700;">
                OpenHW Studio
              </h1>
              <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,0.85);letter-spacing:2px;text-transform:uppercase;">
                ${headerSubtitle}
              </p>
            </td>
          </tr>

          <!-- Content -->
          <tr>
            <td style="padding:36px 32px;">
              ${contentHtml}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#0f172a;border-top:1px solid #1e293b;padding:20px 32px;text-align:center;">
              <p style="margin:0;font-size:12px;color:#475569;line-height:1.6;">
                This is an automated administrative notification from OpenHW Studio.<br />
                If you have any questions or require assistance, please contact our support team.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`;

/**
 * 1. Role Change Email
 */
export function buildRoleChangeEmail(name = 'there', newRole = 'user', oldRole = 'student') {
  const subject = `Your OpenHW Studio role has been updated to ${newRole.toUpperCase()}`;
  const message =
    `Hi ${name},\n\n` +
    `Your account role on OpenHW Studio has been updated by an administrator.\n` +
    `Previous Role: ${oldRole}\n` +
    `New Role: ${newRole}\n\n` +
    `You can now access permissions and features associated with the ${newRole} role upon your next sign in.\n\n` +
    `-- The OpenHW Studio Team`;

  const contentHtml = `
    <p style="margin:0 0 20px;font-size:15px;color:#cbd5e1;">
      Hi <strong style="color:#f1f5f9;">${name}</strong>,
    </p>
    <p style="margin:0 0 24px;font-size:15px;color:#94a3b8;line-height:1.7;">
      An administrator has updated your account permissions on <strong>OpenHW Studio</strong>.
    </p>
    <div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:24px;margin-bottom:24px;">
      <div style="display:flex;justify-content:space-between;margin-bottom:12px;">
        <span style="font-size:13px;color:#64748b;">Previous Role:</span>
        <span style="font-size:13px;color:#cbd5e1;text-transform:capitalize;font-weight:600;">${oldRole}</span>
      </div>
      <div style="display:flex;justify-content:space-between;">
        <span style="font-size:13px;color:#64748b;">New Assigned Role:</span>
        <span style="font-size:14px;color:#38bdf8;text-transform:capitalize;font-weight:700;">${newRole}</span>
      </div>
    </div>
    <p style="margin:0;font-size:14px;color:#94a3b8;line-height:1.6;">
      Your new permissions are active immediately. If you are currently logged in, please refresh or re-authenticate to view your new workspace.
    </p>
  `;

  return {
    subject,
    message,
    html: baseEmailWrapper('OpenHW Studio - Role Update', 'Account Role Changed', contentHtml, '#0ea5e9'),
  };
}

/**
 * 2. Suspension Notice Email
 */
export function buildSuspensionEmail(name = 'there', durationText = 'indefinite', reason = 'Administrative review', resumeDate = null) {
  const subject = 'Notice: Your OpenHW Studio account has been temporarily suspended';
  const resumeMsg = resumeDate ? `Suspension Ends: ${resumeDate}\n` : '';
  const message =
    `Hi ${name},\n\n` +
    `Your OpenHW Studio account has been temporarily suspended by an administrator.\n` +
    `Duration: ${durationText}\n` +
    `${resumeMsg}` +
    `Reason: ${reason}\n\n` +
    `During this period, you will be unable to log in or use the platform.\n` +
    `If you believe this suspension is in error, please reply to support.\n\n` +
    `-- The OpenHW Studio Team`;

  const contentHtml = `
    <p style="margin:0 0 20px;font-size:15px;color:#cbd5e1;">
      Hi <strong style="color:#f1f5f9;">${name}</strong>,
    </p>
    <p style="margin:0 0 24px;font-size:15px;color:#94a3b8;line-height:1.7;">
      Your account access on <strong>OpenHW Studio</strong> has been temporarily suspended by an administrator.
    </p>
    <div style="background:#0f172a;border:1px solid #eab308;border-radius:10px;padding:24px;margin-bottom:24px;">
      <p style="margin:0 0 10px;font-size:12px;color:#eab308;text-transform:uppercase;letter-spacing:1px;font-weight:700;">
        Suspension Details
      </p>
      <p style="margin:0 0 8px;font-size:14px;color:#cbd5e1;">
        <strong>Duration:</strong> ${durationText}
      </p>
      ${resumeDate ? `<p style="margin:0 0 8px;font-size:14px;color:#cbd5e1;"><strong>Expected Re-activation:</strong> ${resumeDate}</p>` : ''}
      <p style="margin:0;font-size:14px;color:#cbd5e1;">
        <strong>Reason:</strong> ${reason}
      </p>
    </div>
    <p style="margin:0;font-size:14px;color:#94a3b8;line-height:1.6;">
      While this suspension is active, you will not be able to log in. Once the suspension period concludes, your access will automatically be restored.
    </p>
  `;

  return {
    subject,
    message,
    html: baseEmailWrapper('OpenHW Studio - Account Suspended', 'Account Suspended', contentHtml, '#f59e0b'),
  };
}

/**
 * 3. Unsuspension Email
 */
export function buildUnsuspensionEmail(name = 'there') {
  const subject = 'Your OpenHW Studio account has been restored';
  const message =
    `Hi ${name},\n\n` +
    `We are pleased to inform you that your OpenHW Studio account suspension has been lifted.\n` +
    `You can now sign in and resume your hardware simulation and coursework.\n\n` +
    `-- The OpenHW Studio Team`;

  const contentHtml = `
    <p style="margin:0 0 20px;font-size:15px;color:#cbd5e1;">
      Hi <strong style="color:#f1f5f9;">${name}</strong>,
    </p>
    <p style="margin:0 0 24px;font-size:15px;color:#94a3b8;line-height:1.7;">
      Your account access on <strong>OpenHW Studio</strong> has been fully restored by an administrator.
    </p>
    <div style="background:#0f172a;border:1px solid #22c55e;border-radius:10px;padding:24px;margin-bottom:24px;text-align:center;">
      <p style="margin:0 0 8px;font-size:18px;color:#4ade80;font-weight:700;">
        Welcome Back!
      </p>
      <p style="margin:0;font-size:14px;color:#94a3b8;">
        Your suspension has concluded and all account features are active.
      </p>
    </div>
    <p style="margin:0;font-size:14px;color:#94a3b8;line-height:1.6;">
      You may now log in to the platform with your existing credentials.
    </p>
  `;

  return {
    subject,
    message,
    html: baseEmailWrapper('OpenHW Studio - Account Restored', 'Account Restored', contentHtml, '#10b981'),
  };
}

/**
 * 4. Account Block Email
 */
export function buildBlockEmail(name = 'there', email = '', reason = 'Violation of platform terms of service') {
  const subject = 'Important: Your OpenHW Studio account and email have been blocked';
  const message =
    `Hi ${name},\n\n` +
    `Your email address (${email}) has been blocked from accessing or registering on OpenHW Studio.\n` +
    `Reason: ${reason}\n\n` +
    `You will not be able to log in or create new accounts using this email address.\n` +
    `If you believe this action was taken in error, you may contact support to appeal.\n\n` +
    `-- The OpenHW Studio Team`;

  const contentHtml = `
    <p style="margin:0 0 20px;font-size:15px;color:#cbd5e1;">
      Hi <strong style="color:#f1f5f9;">${name}</strong>,
    </p>
    <p style="margin:0 0 24px;font-size:15px;color:#94a3b8;line-height:1.7;">
      An administrator has placed an administrative block on your email address (<strong>${email}</strong>) on <strong>OpenHW Studio</strong>.
    </p>
    <div style="background:#0f172a;border:1px solid #ef4444;border-radius:10px;padding:24px;margin-bottom:24px;">
      <p style="margin:0 0 10px;font-size:12px;color:#f87171;text-transform:uppercase;letter-spacing:1px;font-weight:700;">
        Block Notice
      </p>
      <p style="margin:0 0 8px;font-size:14px;color:#cbd5e1;">
        <strong>Blocked Email:</strong> ${email}
      </p>
      <p style="margin:0;font-size:14px;color:#cbd5e1;">
        <strong>Reason:</strong> ${reason}
      </p>
    </div>
    <p style="margin:0;font-size:14px;color:#94a3b8;line-height:1.6;">
      This email is permanently restricted from signing in or registering new accounts on this platform. If you wish to appeal this decision, please contact platform administration.
    </p>
  `;

  return {
    subject,
    message,
    html: baseEmailWrapper('OpenHW Studio - Account Blocked', 'Account Blocked', contentHtml, '#ef4444'),
  };
}

/**
 * 5. Account Unblock Email
 */
export function buildUnblockEmail(name = 'there', email = '') {
  const subject = 'Your OpenHW Studio email block has been removed';
  const message =
    `Hi ${name},\n\n` +
    `The administrative block on your email address (${email}) has been removed.\n` +
    `You are now permitted to sign in or register an account on OpenHW Studio.\n\n` +
    `-- The OpenHW Studio Team`;

  const contentHtml = `
    <p style="margin:0 0 20px;font-size:15px;color:#cbd5e1;">
      Hi <strong style="color:#f1f5f9;">${name}</strong>,
    </p>
    <p style="margin:0 0 24px;font-size:15px;color:#94a3b8;line-height:1.7;">
      The administrative block on your email address (<strong>${email}</strong>) has been lifted by an administrator.
    </p>
    <div style="background:#0f172a;border:1px solid #22c55e;border-radius:10px;padding:24px;margin-bottom:24px;text-align:center;">
      <p style="margin:0 0 8px;font-size:18px;color:#4ade80;font-weight:700;">
        Access Re-enabled
      </p>
      <p style="margin:0;font-size:14px;color:#94a3b8;">
        Your email is no longer restricted on OpenHW Studio.
      </p>
    </div>
    <p style="margin:0;font-size:14px;color:#94a3b8;line-height:1.6;">
      You may now sign in to your existing account or create a new account with this email address.
    </p>
  `;

  return {
    subject,
    message,
    html: baseEmailWrapper('OpenHW Studio - Block Removed', 'Email Unblocked', contentHtml, '#10b981'),
  };
}

/**
 * 6. Permanent Deletion Notice Email
 */
export function buildPermanentDeletionEmail(name = 'there') {
  const subject = 'Your OpenHW Studio account has been deleted';
  const message =
    `Hi ${name},\n\n` +
    `This is confirmation that your account on OpenHW Studio has been permanently deleted by an administrator.\n` +
    `All associated data, enrollments, and progress records have been purged in accordance with our data retention policy.\n\n` +
    `-- The OpenHW Studio Team`;

  const contentHtml = `
    <p style="margin:0 0 20px;font-size:15px;color:#cbd5e1;">
      Hi <strong style="color:#f1f5f9;">${name}</strong>,
    </p>
    <p style="margin:0 0 24px;font-size:15px;color:#94a3b8;line-height:1.7;">
      This email confirms that your account on <strong>OpenHW Studio</strong> has been permanently deleted.
    </p>
    <div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:24px;margin-bottom:24px;">
      <p style="margin:0 0 8px;font-size:14px;color:#cbd5e1;">
        All personal profile data, course enrollments, and project progress records have been purged from our active systems.
      </p>
    </div>
    <p style="margin:0;font-size:14px;color:#64748b;line-height:1.6;">
      Thank you for being part of the OpenHW Studio community.
    </p>
  `;

  return {
    subject,
    message,
    html: baseEmailWrapper('OpenHW Studio - Account Deleted', 'Account Deleted', contentHtml, '#64748b'),
  };
}

/**
 * 7. Welcome & Onboarding Email
 */
export function buildWelcomeOnboardingEmail(name = 'there') {
  const subject = 'Welcome to OpenHW Studio — Getting Started & Community Guidelines';
  const message =
    `Hi ${name},\n\n` +
    `Welcome to OpenHW Studio — your online hardware simulation and embedded learning platform.\n\n` +
    `We are excited to have you join our community!\n\n` +
    `[IMPORTANT NOTICE: PLATFORM UNDER ACTIVE DEVELOPMENT]\n` +
    `Please note that OpenHW Studio is currently under active development. While we are continuously expanding board support, microcontrollers, and educational features, you may occasionally encounter bugs or experimental updates.\n\n` +
    `[OPEN SOURCE CONTRIBUTIONS]\n` +
    `OpenHW Studio is fully open-source. We warmly welcome students, engineers, and makers to participate in building the future of hardware simulation. Whether you want to contribute code, suggest new microcontrollers, improve documentation, or submit components, you can find our repositories on GitHub:\n\n` +
    `GitHub: https://github.com/OpenHW-Studio\n\n` +
    `[REPORTING BUGS & FEEDBACK]\n` +
    `If you encounter any issues or unexpected simulator behavior, you can report them via our in-app Bug Tracker or by opening an issue on GitHub:\n` +
    `https://github.com/OpenHW-Studio/OpenHW-studio-frontend/issues\n\n` +
    `Thank you for being an early adopter and supporting open hardware education!\n\n` +
    `-- The OpenHW Studio Team`;

  const contentHtml = `
    <p style="margin:0 0 20px;font-size:16px;color:#cbd5e1;">
      Hi <strong style="color:#f1f5f9;">${name}</strong>,
    </p>
    <p style="margin:0 0 24px;font-size:15px;color:#94a3b8;line-height:1.7;">
      Welcome to <strong>OpenHW Studio</strong>. Your account is ready, giving you access to real-time hardware simulation, interactive code editing, and virtual labs.
    </p>

    <!-- Notice: Active Development -->
    <div style="background:#0f172a;border:1px solid #38bdf8;border-radius:10px;padding:22px;margin-bottom:24px;">
      <p style="margin:0 0 8px;font-size:12px;color:#38bdf8;text-transform:uppercase;letter-spacing:1px;font-weight:700;">
        Platform Under Active Development
      </p>
      <p style="margin:0;font-size:13px;color:#94a3b8;line-height:1.6;">
        OpenHW Studio is actively being developed and upgraded. While our simulation engines and board peripherals are thoroughly tested, you may encounter occasional bugs or interface refinements as we ship new capabilities.
      </p>
    </div>

    <!-- Open Source & GitHub Contribution -->
    <div style="background:#0f172a;border:1px solid #334155;border-radius:10px;padding:22px;margin-bottom:28px;">
      <p style="margin:0 0 8px;font-size:12px;color:#cbd5e1;text-transform:uppercase;letter-spacing:1px;font-weight:700;">
        Open Source & Contributions
      </p>
      <p style="margin:0 0 16px;font-size:13px;color:#94a3b8;line-height:1.6;">
        We believe in open hardware education. OpenHW Studio is open-source, and we warmly welcome contributions from developers, educators, and makers — including adding new components, reporting issues, or improving simulator engines.
      </p>
      <div style="text-align:left;">
        <a href="https://github.com/OpenHW-Studio"
          style="display:inline-block;background:#38bdf8;color:#0f172a;text-decoration:none;font-size:13px;font-weight:700;padding:10px 18px;border-radius:8px;">
          View on GitHub: https://github.com/OpenHW-Studio
        </a>
      </div>
    </div>

    <!-- Reporting Bugs -->
    <p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">
      If you encounter any bugs or have ideas for new features, please submit an issue via our in-app Bug Tracker or directly on our GitHub repository.
    </p>
  `;

  return {
    subject,
    message,
    html: baseEmailWrapper('OpenHW Studio - Welcome', 'Welcome to the Platform', contentHtml, '#0ea5e9'),
  };
}
