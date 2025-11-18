import express from "express";
import sanitizeHtml from "sanitize-html";

const createEmailRouter = (resend, redis) => {
  const router = express.Router();

  // ── Config ─────────────────────────────────────
  const OTP_TTL_SECONDS = Number(process.env.OTP_TTL_SECONDS) || 600;
  const COOLDOWN_SECONDS = Number(process.env.OTP_COOLDOWN_SECONDS) || 60;
  const MAX_VERIFY_ATTEMPTS = Number(process.env.MAX_VERIFY_ATTEMPTS) || 5;
  const RESEND_OTP_FROM = process.env.FROM_VERIFY || "verify@mail.sakhiledumisa.com";

  // MUST be set in .env — no fallbacks
  const TEMPLATE_INBOX_ID = process.env.RESEND_TEMPLATE_INBOX_ID;
  const TEMPLATE_CONFIRMATION_ID = process.env.RESEND_TEMPLATE_CONFIRMATION_ID;
  const TEMPLATE_OTP_ID = process.env.RESEND_TEMPLATE_OTP_ID;

  if (!TEMPLATE_INBOX_ID || !TEMPLATE_CONFIRMATION_ID || !TEMPLATE_OTP_ID) {
    throw new Error("Missing required Resend template IDs in .env");
  }

  const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

  const titleCase = (str = "") =>
    str
      .trim()
      .toLowerCase()
      .replace(/(^|\s|-)\S/g, (l) => l.toUpperCase());

  // ── SEND CONTACT FORM EMAIL ─────────────────────
  router.post("/api/send-email", async (req, res) => {
    try {
      const { to, userName, sentBy, message, from = "form@mail.sakhiledumisa.com" } = req.body;

      if (!to || !userName || !sentBy || !message)
        return res.status(400).json({ error: "Missing required fields" });

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(to) || !emailRegex.test(sentBy))
        return res.status(400).json({ error: "Invalid email format" });

      if (from !== "form@mail.sakhiledumisa.com")
        return res.status(400).json({ error: "Invalid from address" });

      if (!resend) throw new Error("Resend client not initialized");

      // Sender verification
      if (redis) {
        const verified = await redis.get(`verified:${sentBy}`);
        if (!verified) {
          return res.status(403).json({ error: "Sender email not verified" });
        }
      }

      const titledUserName = titleCase(sanitizeHtml(userName));
      const cleanMessage = sanitizeHtml(message, { allowedTags: [], allowedAttributes: {} }).trim();
      const cleanSentBy = sanitizeHtml(sentBy).trim();

      const subject = `New message from ${titledUserName}`;
      const textFallback = `From: ${titledUserName} <${cleanSentBy}>\n\n${cleanMessage}`;

      // THIS IS THE ONLY WORKING TEMPLATE SYNTAX IN 2025
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

      // Thank-you reply
      await resend.emails.send({
        from: process.env.FROM_CONTACT || from,
        to: cleanSentBy,
        subject: `Thanks, ${titledUserName}!`,
        text: `Hi ${titledUserName},\n\nWe received your message and will reply soon.`,
        template_id: TEMPLATE_CONFIRMATION_ID,
        template_variables: {
          userName: titledUserName,
        },
      }).catch((err) => console.warn("Thank-you email failed:", err.message));

      res.json({ success: true, data });
    } catch (error) {
      console.error("Send email error:", error);
      res.status(error.statusCode || 500).json({ error: error.message || "Failed to send" });
    }
  });

  // ── SEND OTP ───────────────────────────────────
  router.post("/api/send-otp", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return res.status(400).json({ error: "Valid email required" });

      if (!resend) throw new Error("Resend not initialized");

      if (redis) {
        const key = `otp-cooldown:${email}`;
        if (await redis.get(key)) return res.status(429).json({ error: "Wait before retrying" });
        await redis.set(key, "1", { EX: COOLDOWN_SECONDS });
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
        text: `Your code: ${code}`,
        template_id: TEMPLATE_OTP_ID,
        template_variables: { code },
      });

      res.json({ success: true });
    } catch (error) {
      console.error("OTP send failed:", error);
      res.status(500).json({ error: "Failed to send OTP" });
    }
  });

  // ── VERIFY OTP ─────────────────────────────────
  router.post("/api/verify-otp", async (req, res) => {
    try {
      const { email, code } = req.body;
      if (!email || !code) return res.status(400).json({ error: "Email and code required" });
      if (!redis) return res.status(500).json({ error: "Redis required" });

      const stored = await redis.get(`otp:${email}`);
      if (!stored) return res.status(400).json({ error: "Code expired or invalid" });

      const attemptsKey = `otp-attempts:${email}`;
      const attempts = await redis.incr(attemptsKey);
      if (attempts === 1) await redis.expire(attemptsKey, OTP_TTL_SECONDS);

      if (attempts > MAX_VERIFY_ATTEMPTS)
        return res.status(429).json({ error: "Too many attempts — try again later" });

      if (stored !== String(code).trim())
        return res.status(400).json({ error: "Incorrect code" });

      await redis.del(`otp:${email}`);
      await redis.del(attemptsKey);
      await redis.set(`verified:${email}`, "1");

      res.json({ success: true, message: "Email verified!" });
    } catch (error) {
      console.error("OTP verify error:", error);
      res.status(500).json({ error: "Verification failed" });
    }
  });

  return router;
};

export default createEmailRouter;