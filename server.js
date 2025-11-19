import express from "express";
import cors from "cors";
import helmet from "helmet";
import { Resend } from "resend";
import rateLimit from "express-rate-limit";
import morgan from "morgan";
import dotenv from "dotenv";
import emailRoutes from "./routes/emailRoute.js";
import { createClient } from 'redis';
import path from 'path';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;


// Initialize Resend
let resend;
try {
  if (!process.env.RESEND_API_KEY) {
    throw new Error("RESEND_API_KEY is not set");
  }
  resend = new Resend(process.env.RESEND_API_KEY);
} catch (error) {
  console.error("Failed to initialize Resend:", error.message);
  process.exit(1); // Exit if Resend initialization fails
}

// Initialize Redis client from separate env vars (preferred: host/port/username/password)
// Required env vars: REDIS_HOST and REDIS_PASSWORD. Optional: REDIS_PORT, REDIS_USERNAME, REDIS_TLS.
let redisClient = null;
const hasRedisConfig = process.env.REDIS_HOST && process.env.REDIS_PASSWORD;
if (hasRedisConfig) {
  try {
    const redisOptions = {
      username: process.env.REDIS_USERNAME || 'default',
      password: process.env.REDIS_PASSWORD,
      socket: {
        host: process.env.REDIS_HOST,
        port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,
      },
    };

    // If REDIS_TLS is set to 'true', enable TLS (some providers require TLS)
    if (String(process.env.REDIS_TLS).toLowerCase() === 'true') {
      redisOptions.socket.tls = true;
    }

    redisClient = createClient(redisOptions);
    redisClient.on('error', (err) => console.error('Redis Client Error', err));

    // Wait for Redis to connect before starting the app — ensures verification flow is available.
    await redisClient.connect();
    console.log('Redis connected');
  } catch (err) {
    console.error('Failed to initialize Redis client', err.message);
    redisClient = null;
  }
} else {
  console.log('REDIS_HOST/REDIS_PASSWORD not set — running without Redis');
}

// Security middleware
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
});
app.use(limiter);
app.use(helmet());
app.use(express.json());
app.use(morgan("combined"));
app.use(express.static('public'));

// CORS configuration
const corsOptions = {
  origin: [
    "https://www.sakhiledumisa.com",
        "https://www.sakhiledumisa.com",
    "https://www.sakhiledumisa.info",
    "https://www.sakhiledumisa.info",
    "https://sakhile-dumisa.vercel.app",
    "http://localhost:3000"
  ],
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "x-api-key"],
  credentials: true,
  optionsSuccessStatus: 204,
};
app.use(cors(corsOptions));


app.use("/email", emailRoutes(resend, redisClient)); // Email routes at /email/api/...


// Health check endpoints
app.get("/", (req, res) => {
  res.status(200).json({ message: "Portfolio Email API is running" });
});

app.get("/health", (req, res) => {
  res.status(200).json({ status: "OK", uptime: process.uptime() });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err.stack);
  res.status(err.statusCode || 500).json({
    error: err.message || "Something went wrong!",
  });
});

// Serve favicon directly from `public` without any auth
app.get('/favicon.ico', (req, res) => {
  const faviconPath = path.join(process.cwd(), 'public', 'favicon.ico');
  return res.sendFile(faviconPath, (err) => {
    if (err) {
      res.status(404).end();
    }
  });
});

// simple API key middleware
app.use((req, res, next) => {
  const key = req.headers['x-api-key'] || req.get('x-api-key');
  if (!process.env.X_API_KEY) {
    console.warn('X_API_KEY not set in env — bypassing API key check');
    return next();
  }
  if (!key || key !== process.env.X_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized: invalid API key' });
  }
  next();
});

  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
    console.log(`MongoDB: Connected`);
    console.log(`Resend: ${resend ? 'Initialized' : 'Not configured'}`);
  });


export default app;