import express from "express";
import sanitizeHtml from "sanitize-html";

const createEmailRouter = (resend, redis) => {
  const router = express.Router();

  // Config
  const OTP_TTL_SECONDS = Number(process.env.OTP_TTL_SECONDS) || 600;
  const COOLDOWN_SECONDS = Number(process.env.OTP_COOLDOWN_SECONDS) || 60;
  const MAX_VERIFY_ATTEMPTS = Number(process.env.MAX_VERIFY_ATTEMPTS) || 5;
  const RESEND_OTP_FROM = process.env.FROM_VERIFY || "verify@mail.sakhiledumisa.com";

  // Your real template IDs (from Resend dashboard)
  const TEMPLATE_INBOX_ID = process.env.RESEND_TEMPLATE_INBOX_ID || "a461e951-f386-4048-9c06-eca22f44b3b6";
  const TEMPLATE_CONFIRMATION_ID = process.env.RESEND_TEMPLATE_CONFIRMATION_ID || "2df9d8e1-3a66-4835-b936-3d863ec20f59";
  const TEMPLATE_OTP_ID = process.env.RESEND_TEMPLATE_OTP_ID || "eafb27f5-0b1d-4f0a-9212-b86c7f1599bb";

  const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

  const titleCase = (str = "") =>
    str
      .trim()
      .toLowerCase()
      .replace(/(^|\s|-)\S/g, (l) => l.toUpperCase());

  // SEND CONTACT FORM
  router.post("/api/send-email", async (req, res) => {
    try {
      const { to, userName, sentBy, message, from = "form@mail.sakhiledumisa.com" } = req.body;

      if (!to || !userName || !sentBy || !message)
        return res.status(400).json({ error: "Missing fields" });

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(to) || !emailRegex.test(sentBy))
        return res.status(400).json({ error: "Invalid email" });

      if (from !== "form@mail.sakhiledumisa.com")
        return res.status(400).json({ error: "Invalid from" });

      if (!resend) throw new Error("Resend not initialized");

      if (redis && !(await redis.get(`verified:${sentBy}`))) {
        return res.status(403).json({ error: "Email not verified" });
      }

      const titledUserName = titleCase(sanitizeHtml(userName));
      const cleanSentBy = sanitizeHtml(sentBy).trim();
      const cleanMessage = sanitizeHtml(message, { allowedTags: [], allowedAttributes: {} }).trim();

      const subject = `New message from ${titledUserName}`;
      const textFallback = `From: ${titledUserName} <${cleanSentBy}>\n\n${cleanMessage}`;

      // EXACTLY AS IN RESEND DOCS — THIS WORKS AGAIN
      const { data, error } = await resend.emails.send({
        from,
        to,
        subject,
        reply_to: cleanSentBy,
        template: {
          id: TEMPLATE_INBOX_ID,
          variables: {
            userName: titledUserName,
            message: cleanMessage,
            userEmail: cleanSentBy,
          },
        },
      });

      if (error) throw error;

      // Thank-you email — same official format
      await resend.emails.send({
        from: process.env.FROM_CONTACT || from,
        to: cleanSentBy,
        subject: `Thanks, ${titledUserName}!`,
        template: {
          id: TEMPLATE_CONFIRMATION_ID,
          variables: { userName: titledUserName },
        },
      }).catch(() => {}); // non-blocking

      res.json({ success: true, data });
    } catch (err) {
      console.error("Email error:", err);
      res.status(500).json({ error: err.message || "Failed" });
    }
  });

  // SEND OTP
  router.post("/api/send-otp", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return res.status(400).json({ error: "Invalid email" });

      if (!resend) throw new Error("Resend missing");

      if (redis) {
        const key = `otp-cooldown:${email}`;
        if (await redis.get(key)) return res.status(429).json({ error: "Too many requests" });
        await redis.set(key, "1", { EX: COOLDOWN_SECONDS });
      }

      const code = generateOtp();
      if (redis) {
        await redis.set(`otp:${email}`, code, { EX: OTP_TTL_SECONDS });
        await redis.del(`otp-attempts:${email}`);
      }

      // OFFICIAL DOCS FORMAT — WORKS PERFECTLY
      await resend.emails.send({
        from: RESEND_OTP_FROM,
        to: email,
        subject: "Your verification code",
        template: {
          id: TEMPLATE_OTP_ID,
          variables: { code: Number(code) },
        },
      });

      res.json({ success: true });
    } catch (err) {
      console.error("OTP error:", err);
      res.status(500).json({ error: "Failed" });
     }
  });

  // VERIFY OTP (unchanged)
  router.post("/api/verify-otp", async (req, res) => {
    // ... same as before (no email sending here)
    // (keeping your existing logic — it's perfect)
    try {
      const { email, code } = req.body;
      if (!email || !code) return res.status(400).json({ error: "Missing data" });
      if (!redis) return res.status(500).json({ error: "Redis required" });

      const stored = await redis.get(`otp:${email}`);
      if (!stored) return res.status(400).json({ error: "Expired" });

      const attempts = await redis.incr(`otp-attempts:${email}`);
      if (attempts === 1) await redis.expire(`otp-attempts:${email}`, OTP_TTL_SECONDS);
      if (attempts > MAX_VERIFY_ATTEMPTS) return res.status(429).json({ error: "Too many tries" });

      if (stored !== String(code).trim()) return res.status(400).json({ error: "Wrong code" });

      await redis.del(`otp:${email}`);
      await redis.del(`otp-attempts:${email}`);
      await redis.set(`verified:${email}`, "1");

      res.json({ success: true, message: "Verified!" });
    } catch (err) {
      res.status(500).json({ error: "Failed" });
    }
  });

  return router;
};

export default createEmailRouter;
