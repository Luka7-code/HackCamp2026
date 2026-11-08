"use strict";

const nodemailer = require("nodemailer");
const { httpError, isValidEmail, sanitizeHeaderValue } = require("./validation");

function createEmailClient(config) {
  const { host, port, secure, user, pass, from, replyTo } = config.email;
  const configured = Boolean(user && pass && from);
  let transport = null;

  function getTransport() {
    if (!transport) {
      transport = nodemailer.createTransport({
        host,
        port,
        secure,
        auth: { user, pass },
      });
    }
    return transport;
  }

  return {
    configured,
    from,

    async send({ to, subject, text, html, replyTo: reply }) {
      if (!configured) {
        throw httpError(
          503,
          "EMAIL_NOT_CONFIGURED",
          "Gmail SMTP is not configured. Set SMTP_USER, SMTP_PASS and EMAIL_FROM.",
        );
      }
      if (!isValidEmail(to)) {
        throw httpError(400, "INVALID_SUPPLIER_EMAIL", "Supplier email address is invalid.");
      }

      const replyAddress = reply || replyTo;
      if (replyAddress && !isValidEmail(replyAddress)) {
        throw httpError(400, "INVALID_REPLY_TO", "Reply-To address is invalid.");
      }

      const info = await getTransport().sendMail({
        from,
        to,
        subject: sanitizeHeaderValue(subject),
        text,
        html,
        replyTo: replyAddress || undefined,
      });

      return {
        messageId: info.messageId || "",
        accepted: info.accepted || [],
        rejected: info.rejected || [],
      };
    },
  };
}

module.exports = { createEmailClient };
