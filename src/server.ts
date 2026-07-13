import Fastify from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import fp from "fastify-plugin";
import fs from "fs";
import path from "path";

// Validate env variables first at startup
import { env } from "./config/env";
import { errorHandler } from "./middleware/errorHandler";
import databasePlugin from "./plugins/database";
import authPlugin from "./plugins/auth";
import jobsPlugin from "./plugins/jobs";

// Import routes
import publicRoutes from "./routes/public";
import authRoutes from "./routes/auth";
import farmersRoutes from "./routes/farmers";
import agentsRoutes from "./routes/agents";
import tokensRoutes from "./routes/tokens";
import adminRoutes from "./routes/admin";
import adminAuthRoutes from "./routes/adminAuth";
import partnerRoutes from "./routes/partner";
import webhooksRoutes from "./routes/webhooks";
import cropSubmissionsRoutes from "./routes/cropSubmissions";
import atmosphericRoutes from "./routes/atmospheric";
import usersRoutes from "./routes/users";

// Payments subroutes
import airtimeRoutes from "./routes/payments/airtime";
import vouchersRoutes from "./routes/payments/vouchers";
import circleRoutes from "./routes/payments/circle";

const server = Fastify({
  logger: {
    level: env.NODE_ENV === "production" ? "info" : "debug",
  },
  bodyLimit: 1048576, // 1MB JSON body limit
});

async function main() {
  try {
    // 1. Register Helmet for security headers
    await server.register(helmet, {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", "data:", "https://*.r2.cloudflarestorage.com"],
        },
      },
      frameguard: {
        action: "deny",
      },
      referrerPolicy: {
        policy: "strict-origin-when-cross-origin",
      },
    });

    // 2. Register CORS with whitelist
    await server.register(cors, {
      origin: ["https://app.diraafrica.org", "http://localhost:3000"],
      methods: ["GET", "POST", "PATCH", "DELETE"],
      allowedHeaders: ["Content-Type", "Authorization"],
      credentials: true,
      maxAge: 86400,
    });

    // 3. Register global rate limiter (100 req/min/IP)
    await server.register(rateLimit, {
      max: 100,
      timeWindow: "1 minute",
      hook: "preValidation",
      errorResponseBuilder: (request, context) => {
        const error = new Error("Rate limit exceeded. Please try again later. / Umefikia kikomo cha maombi. Tafadhali jaribu tena baadaye.") as any;
        error.statusCode = 429;
        return error;
      },
    });

    // 4. Register JWT plugin
    await server.register(jwt, {
      secret: env.JWT_SECRET,
    });

    // Register separate admin JWT namespace
    await server.register(fp(async (instance) => {
      await instance.register(jwt, {
        secret: process.env.ADMIN_JWT_SECRET || (env.JWT_SECRET + "_admin_hardened"),
        namespace: "admin",
      });
    }));

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

    // 6.5. Register background jobs (BullMQ)
    await server.register(jobsPlugin);

    // 7. Register Global Error Handler
    server.setErrorHandler(errorHandler);

    // 7. Register Routes
    await server.register(publicRoutes);
    await server.register(authRoutes, { prefix: "/api/auth" });
    await server.register(farmersRoutes, { prefix: "/api/farmers" });
    await server.register(agentsRoutes, { prefix: "/api/agents" });
    await server.register(tokensRoutes, { prefix: "/api/tokens" });
    await server.register(adminAuthRoutes, { prefix: "/api/admin/auth" });
    await server.register(adminRoutes, { prefix: "/api/admin" });
    await server.register(partnerRoutes, { prefix: "/api/partner" });
    await server.register(webhooksRoutes, { prefix: "/api/webhooks" });
    await server.register(cropSubmissionsRoutes, { prefix: "/api/crop-submissions" });
    await server.register(atmosphericRoutes, { prefix: "/api/atmospheric" });
    await server.register(usersRoutes, { prefix: "/api/users" });

    // Payments subroutes
    await server.register(airtimeRoutes, { prefix: "/api/payments/airtime" });
    await server.register(vouchersRoutes, { prefix: "/api/payments/vouchers" });
    await server.register(circleRoutes, { prefix: "/api/payments/circle" });

    // security.txt route
    server.get("/.well-known/security.txt", async (request, reply) => {
      return reply.type("text/plain").send("Contact: security@diraafrica.org\n");
    });

    // Local static file serving fallback for uploads
    server.get("/uploads/:filename", async (request, reply) => {
      const filePath = path.join(__dirname, "../public/uploads", (request.params as any).filename);
      if (!fs.existsSync(filePath)) {
        return reply.status(404).send({ error: "File not found" });
      }
      const stream = fs.createReadStream(filePath);
      return reply.type("image/jpeg").send(stream);
    });

    // Start server
    await server.listen({ port: env.PORT, host: env.HOST });
    console.log(`🚀 Dira Backend API server listening on http://${env.HOST}:${env.PORT}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

main();
