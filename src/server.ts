import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";

// Validate env variables first at startup
import { env } from "./config/env";
import { errorHandler } from "./middleware/errorHandler";
import databasePlugin from "./plugins/database";
import authPlugin from "./plugins/auth";

// Import routes
import publicRoutes from "./routes/public";
import authRoutes from "./routes/auth";
import farmersRoutes from "./routes/farmers";
import agentsRoutes from "./routes/agents";
import tokensRoutes from "./routes/tokens";
import adminRoutes from "./routes/admin";
import partnerRoutes from "./routes/partner";
import webhooksRoutes from "./routes/webhooks";

// Payments subroutes
import airtimeRoutes from "./routes/payments/airtime";
import vouchersRoutes from "./routes/payments/vouchers";
import circleRoutes from "./routes/payments/circle";
import mpesaRoutes from "./routes/payments/mpesa";

const server = Fastify({
  logger: {
    level: env.NODE_ENV === "production" ? "info" : "debug",
  },
});

async function main() {
  try {
    // 1. Register Helmet for security headers
    await server.register(helmet, {
      contentSecurityPolicy: env.NODE_ENV === "production" ? undefined : false,
    });

    // 2. Register CORS with whitelist
    await server.register(cors, {
      origin: (origin, cb) => {
        const whitelist = ["https://app.dira.africa", "http://localhost:3000"];
        // Allow requests with no origin (like mobile apps, curl, postman)
        if (!origin || whitelist.includes(origin)) {
          cb(null, true);
        } else {
          cb(new Error("Not allowed by CORS"), false);
        }
      },
    });

    // 3. Register global rate limiter (100 req/min/IP)
    await server.register(rateLimit, {
      max: 100,
      timeWindow: "1 minute",
      errorResponseBuilder: (request, context) => {
        const error = new Error("Rate limit exceeded. Please try again in a minute.") as any;
        error.statusCode = 429;
        return error;
      },
    });

    // 4. Register JWT plugin
    await server.register(jwt, {
      secret: env.JWT_SECRET,
    });

    // 4.5. Register Custom Auth Decorators Plugin
    await server.register(authPlugin);

    // 5. Register Multipart plugin for file uploads
    await server.register(multipart, {
      limits: {
        fieldNameSize: 100, // Max field name size in bytes
        fieldSize: 1000000, // Max field value size in bytes
        fields: 10,         // Max number of non-file fields
        fileSize: 10000000, // Max file size in bytes (10MB)
        files: 1,           // Max number of file fields
      },
    });

    // 6. Register Database connection pool
    await server.register(databasePlugin);

    // 7. Register Global Error Handler
    server.setErrorHandler(errorHandler);

    // 7. Register Routes
    await server.register(publicRoutes);
    await server.register(authRoutes, { prefix: "/api/auth" });
    await server.register(farmersRoutes, { prefix: "/api/farmers" });
    await server.register(agentsRoutes, { prefix: "/api/agents" });
    await server.register(tokensRoutes, { prefix: "/api/tokens" });
    await server.register(adminRoutes, { prefix: "/api/admin" });
    await server.register(partnerRoutes, { prefix: "/api/partner" });
    await server.register(webhooksRoutes, { prefix: "/api/webhooks" });

    // Payments subroutes
    await server.register(airtimeRoutes, { prefix: "/api/payments/airtime" });
    await server.register(vouchersRoutes, { prefix: "/api/payments/vouchers" });
    await server.register(circleRoutes, { prefix: "/api/payments/circle" });
    await server.register(mpesaRoutes, { prefix: "/api/payments/mpesa" });

    // Start server
    await server.listen({ port: env.PORT, host: env.HOST });
    console.log(`🚀 Dira Backend API server listening on http://${env.HOST}:${env.PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
