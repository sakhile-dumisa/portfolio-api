import express from "express";
import sanitizeHtml from "sanitize-html";

const createEmailRouter = (resend, redis) => {
  const router = express.Router();

  // ── Config (all from .env) ─────────────────────────────
  const OTP_TTL_SECONDS = Number(process.env.OTP_TTL_SECONDS) || 600;
  const COOLDOWN_SECONDS = Number(process.env.OTP_COOLDOWN_SECONDS) || 60;
  const MAX_VERIFY_ATTEMPTS = Number(process.env.MAX_VERIFY_ATTEMPTS) || 5;
  const RESEND_OTP_FROM = process.env.FROM_VERIFY || "verify@mail.sakhiledumisa.com";

  const TEMPLATE_INBOX_ID = process.env.RESEND_TEMPLATE_INBOX_ID;
  const TEMPLATE_CONFIRMATION_ID = process.env.RESEND_TEMPLATE_CONFIRMATION_ID;
  const TEMPLATE_OTP_ID = process.env.RESEND_TEMPLATE_OTP_ID;

  // Safety check
  if (!TEMPLATE_INBOX_ID || !TEMPLATE_CONFIRMATION_ID || !TEMPLATE_OTP_ID) {
    console.error("❌ Missing Resend template IDs in .env — emails will fail!");
  }

  const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

  const titleCase = (str = "") =>
    str
      .trim()
      .toLowerCase()
      .replace(/(^|\s|-)\S/g, (l) => l.toUpperCase());

  // ── SEND CONTACT FORM EMAIL ─────────────────────────────
  router.post("/api/send-email", async (req, res) => {
    try {
      const { to, userName, sentBy, message, from = "form@mail.sakhiledumisa.com" } = req.body;

      if (!to || !userName || !sentBy || !message)
        return res.status(400).json({ error: "Missing required fields" });

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(to) || !emailRegex.test(sentBy))
        return res.status(400).json({ error: "Invalid email" });

      if (from !== "form@mail.sakhiledumisa.com")
        return res.status(400).json({ error: "Invalid from address" });

      if (!resend) throw new Error("Resend not initialized");

      // Verify sender email
      if (redis && !(await redis.get(`verified:${sentBy}`))) {
        return res.status(403).json({ error: "Sender email not verified" });
      }

      const titledUserName = titleCase(sanitizeHtml(userName));
      const cleanMessage = sanitizeHtml(message, { allowedTags: [], allowedAttributes: {} }).trim();
      const cleanSentBy = sanitizeHtml(sentBy).trim();

      const subject = `New message from ${titledUserName}`;
      const textFallback = `From: ${titledUserName} <${cleanSentBy}>\n\n${cleanMessage}`;

      // Main templated email
      const data = await resend.emails.send({
        from,
        to,
        subject,
        text: textFallback,
        reply_to: cleanSentBy,
        template_id: TEMPLATE_INBOX_ID,
        template_variables: {
          userName: titledUserName,
          message: cleanMessage,
          userEmail: cleanSentBy,
        },
      });

      // Thank-you auto-reply
      try {
        await resend.emails.send({
          from: process.env.FROM_CONTACT || from,
          to: cleanSentBy,
          subject: `Thanks, ${titledUserName}! We got your message.`,
          text: `Hi ${titledUserName},\n\nThanks for reaching out — we'll reply soon!`,
          template_id: TEMPLATE_CONFIRMATION_ID,
          template_variables: { userName: titledUserName },
        });
      } catch (err) {
        console.warn("Thank-you email failed (non-blocking):", err.message);
      }

      res.json({ success: true, data });
    } catch (error) {
      console.error("Send email failed:", error);
      res.status(error.statusCode || 500).json({ error: error.message || "Failed" });
    }
  });

  // ── SEND OTP ───────────────────────────────────────────
  router.post("/api/send-otp", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return res.status(400).json({ error: "Valid email required" });

      if (!resend) throw new Error("Resend not initialized");

      if (redis) {
        const cooldown = await redis.get(`otp-cooldown:${email}`);
        if (cooldown) return res.status(429).json({ error: "Too many requests" });
        await redis.set(`otp-cooldown:${email}`, "1", { EX: COOLDOWN_SECONDS });
      }

      const code = generateOtp();
      if (redis) {
        await redis.set(`otp:${email}`, code, { EX: OTP_TTL_SECONDS });
        await redis.del(`otp-attempts:${email}`);
      }

      await resend.emails.send({
        from: RESEND_OTP_FROM,
        to: email,
        subject: "Your verification code",
        text: `Code: ${code}`,
        template_id: TEMPLATE_OTP_ID,
        template_variables: { code },
      });

      res.json({ success: true, message: "OTP sent" });
    } catch (error) {
      console.error("OTP failed:", error);
      res.status(500).json({ error: "Failed to send OTP" });
    }
  });

  // ── VERIFY OTP ─────────────────────────────────────────
  router.post("/api/verify-otp", async (req, res) => {
    try {
      const { email, code } = req.body;
      if (!email || !code) return res.status(400).json({ error: "Email & code required" });
      if (!redis) return res.status(500).json({ error: "Redis required" });

      const stored = await redis.get(`otp:${email}`);
      if (!stored) return res.status(400).json({ error: "Invalid or expired code" });

      const attempts = await redis.incr(`otp-attempts:${email}`);
      if (attempts === 1) await redis.expire(`otp-attempts:${email}`, OTP_TTL_SECONDS);
      if (attempts > MAX_VERIFY_ATTEMPTS)
        return res.status(429).json({ error: "Too many attempts" });

      if (stored !== String(code).trim())
        return res.status(400).json({ error: "Wrong code" });

      await redis.del(`otp:${email}`);
      await redis.del(`otp-attempts:${email}`);
      await redis.set(`verified:${email}`, "1");

      res.json({ success: true, message: "Verified!" });
    } catch (error) {
      console.error("Verify failed:", error);
      res.status(500).json({ error: "Verification error" });
    }
  });

  return router;
};

export default createEmailRouter;