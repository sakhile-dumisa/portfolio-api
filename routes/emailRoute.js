import express from "express";
import sanitizeHtml from "sanitize-html";

const createEmailRouter = (resend, redis) => {
  const router = express.Router();

  // Config
  const OTP_TTL_SECONDS = Number(process.env.OTP_TTL_SECONDS) || 600; // 10 min
  const COOLDOWN_SECONDS = Number(process.env.OTP_COOLDOWN_SECONDS) || 60;
  const MAX_VERIFY_ATTEMPTS = Number(process.env.MAX_VERIFY_ATTEMPTS) || 5;
  const RESEND_OTP_FROM = process.env.FROM_VERIFY || "verify@mail.sakhiledumisa.com";

  // Required: Set these in your .env (exact IDs from your Resend account)
  const TEMPLATE_INBOX_ID = process.env.RESEND_TEMPLATE_INBOX_ID || "a461e951-f386-4048-9c06-eca22f44b3b6";
  const TEMPLATE_CONFIRMATION_ID =
    process.env.RESEND_TEMPLATE_CONFIRMATION_ID || "2df9d8e1-3a66-4835-b936-3d863ec20f59";
  const TEMPLATE_OTP_ID = process.env.RESEND_TEMPLATE_OTP_ID || "eafb27f5-0b1d-4f0a-9212-b86c7f1599bb";

  const generateOtp = () => Math.floor(100000 + Math.random() * 900000).toString();

  const titleCase = (input = "") => {
    return String(input)
      .trim()
      .split(/\s+/)
      .map((word) =>
        word
          .split(/-/g)
          .map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1).toLowerCase() : part))
          .join("-")
      )
      .join(" ");
  };

  // ====================== SEND CONTACT FORM EMAIL ======================
  router.post("/api/send-email", async (req, res) => {
    try {
      const { to, userName, sentBy, message, from = "form@mail.sakhiledumisa.com" } = req.body;

      // Validation
      if (!to || !userName || !sentBy || !message) {
        return res.status(400).json({ error: "Missing required fields" });
      }

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(to) || !emailRegex.test(sentBy)) {
        return res.status(400).json({ error: "Invalid email format" });
      }

      if (from !== "form@mail.sakhiledumisa.com") {
        return res.status(400).json({ error: "Invalid from address" });
      }

      if (!resend) throw new Error("Resend client not initialized");

      // Email verification check
      if (redis) {
        const isVerified = await redis.get(`verified:${sentBy}`);
        if (!isVerified) {
          return res.status(403).json({
            error: "Sender email not verified. Please verify via OTP first.",
          });
        }
      } else {
        console.warn("Redis not available — skipping sender verification (insecure mode)");
      }

      // Sanitize
      const titledUserName = titleCase(sanitizeHtml(userName, { allowedTags: [], allowedAttributes: {} }).trim());
      const cleanMessage = sanitizeHtml(message, { allowedTags: [], allowedAttributes: {} }).trim();
      const cleanSentBy = sanitizeHtml(sentBy, { allowedTags: [], allowedAttributes: {} }).trim();

      const subject = `New contact form message from ${titledUserName}`;
      const textBody = `New message from ${titledUserName} <${sentBy}>:\n\n${cleanMessage}\n\nReply to: ${sentBy}`;

      // === Main inbox email (uses real template ID) ===
      const data = await resend.emails.send({
        from,
        to,
        subject,
        text: textBody,
        reply_to: sentBy,
        template_id: TEMPLATE_INBOX_ID,
        template_variables: {
          userName: titledUserName,
          message: cleanMessage,
          userEmail: cleanSentBy, // matches {{userEmail}} in your template
        },
      });

      // === Auto-reply thank-you email ===
      const thankFrom = process.env.FROM_CONTACT || from;
      const thankSubject = `Thanks for your message, ${titledUserName}`;
      const thankText = `Hi ${titledUserName},\n\nThanks for reaching out — we'll get back to you shortly!`;

      let thankYouResult = null;
      try {
        thankYouResult = await resend.emails.send({
          from: thankFrom,
          to: sentBy,
          subject: thankSubject,
          text: thankText,
          template_id: TEMPLATE_CONFIRMATION_ID,
          template_variables: {
            userName: titledUserName,
          },
        });
      } catch (err) {
        console.error("Failed to send thank-you email:", err);
        // Don't fail the whole request if auto-reply fails
      }

      res.status(200).json({
        message: "Email sent successfully",
        data,
        thankYou: thankYouResult || "skipped/failed",
      });
    } catch (error) {
      console.error("Send email error:", error);
      res.status(error.statusCode || 500).json({ error: error.message || "Internal server error" });
    }
  });

  // ====================== SEND OTP ======================
  router.post("/api/send-otp", async (req, res) => {
    try {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: "Missing email" });

      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) return res.status(400).json({ error: "Invalid email" });

      if (!resend) throw new Error("Resend client not initialized");

      // No Redis → insecure fallback (only for dev)
      if (!redis) {
        const code = generateOtp();
        await resend.emails.send({
          from: RESEND_OTP_FROM,
          to: email,
          subject: "Your verification code",
          text: `Your code: ${code}`,
          template_id: TEMPLATE_OTP_ID,
          template_variables: { code },
        });
        return res.status(200).json({ message: "OTP sent (no redis)", code }); // never do this in prod!
      }

      // Cooldown check
      const cooldownKey = `otp-cooldown:${email}`;
      const set = await redis.set(cooldownKey, "1", { NX: true, EX: COOLDOWN_SECONDS });
      if (!set) return res.status(429).json({ error: "Too many requests. Wait a minute." });

      const code = generateOtp();
      const otpKey = `otp:${email}`;
      await redis.set(otpKey, code, { EX: OTP_TTL_SECONDS });
      await redis.del(`otp-attempts:${email}`);

      await resend.emails.send({
        from: RESEND_OTP_FROM,
        to: email,
        subject: "Your verification code",
        text: `Your code is ${code}. Expires in ${Math.floor(OTP_TTL_SECONDS / 60)} minutes.`,
        template_id: TEMPLATE_OTP_ID,
        template_variables: { code },
      });

      res.json({ message: "OTP sent" });
    } catch (error) {
      console.error("OTP send error:", error);
      res.status(500).json({ error: "Failed to send OTP" });
    }
  });

  // ====================== VERIFY OTP ======================
  router.post("/api/verify-otp", async (req, res) => {
    try {
      const { email, code } = req.body;
      if (!email || !code) return res.status(400).json({ error: "Missing email or code" });
      if (!redis) return res.status(500).json({ error: "Verification not available" });

      const stored = await redis.get(`otp:${email}`);
      if (!stored) return res.status(400).json({ error: "Code expired or not requested" });

      const attemptsKey = `otp-attempts:${email}`;
      const attempts = await redis.incr(attemptsKey);
      if (attempts === 1) await redis.expire(attemptsKey, OTP_TTL_SECONDS);
      if (attempts > MAX_VERIFY_ATTEMPTS)
        return res.status(429).json({ error: "Too many attempts. Request a new code." });

      if (stored !== String(code).trim()) return res.status(400).json({ error: "Invalid code" });

      // Success
      await redis.del(`otp:${email}`);
      await redis.del(attemptsKey);
      await redis.set(`verified:${email}`, "1"); // permanent (or add TTL if you want)

      res.json({ message: "Email verified successfully" });
    } catch (error) {
      console.error("OTP verify error:", error);
      res.status(500).json({ error: "Verification failed" });
    }
  });

  return router;
};

export default createEmailRouter;