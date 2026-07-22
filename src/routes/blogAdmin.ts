/*
 * Copyright 2026 Dira Africa
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { FastifyInstance } from "fastify";
import { query } from "../db/query";
import { enforceAdminIpAllowlist, getClientIp } from "../middleware/adminIpAllowlistMiddleware";

/**
 * Sanitise raw markdown text to strip stored XSS vectors.
 * We cannot execute markdown here — this runs before storage.
 * The frontend renderer must also sanitise on output.
 */
function sanitiseMarkdown(raw: string): string {
  return raw
    // Remove HTML script tags entirely
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    // Remove dangerous event attributes
    .replace(/\s+on\w+\s*=\s*["'][^"']*["']/gi, "")
    .replace(/\s+on\w+\s*=\s*[^\s>]*/gi, "")
    // Remove javascript: protocol in links
    .replace(/javascript\s*:/gi, "")
    // Remove data: URI in images
    .replace(/data\s*:\s*text\s*\/\s*html/gi, "")
    // Remove <iframe> and <embed> and <object> tags
    .replace(/<(iframe|embed|object|form)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<(iframe|embed|object|form)[^>]*>/gi, "");
}

/**
 * Auto-generate a slug from a title string
 */
function generateSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim()
    .substring(0, 80);
}

export default async function blogAdminRoutes(fastify: FastifyInstance) {
  // 1. Enforce IP allowlist
  fastify.addHook("preHandler", enforceAdminIpAllowlist);
  // 2. Enforce admin auth on all blog routes
  fastify.addHook("onRequest", fastify.authenticateAdmin);

  // ==============================
  // PUBLIC BLOG ENDPOINTS (no auth)
  // ==============================

  // GET /api/blog — list published posts (public)
  fastify.get(
    "/public",
    { onRequest: [] as any },
    async (request, reply) => {
      try {
        const res = await query(
          `SELECT id, slug, title, excerpt, cover_image_url, published_at, meta_title, meta_description
           FROM blog_posts WHERE status = 'published'
           ORDER BY published_at DESC`
        );
        return { success: true, posts: res.rows };
      } catch (err) {
        return reply.status(500).send({ success: false, error: { code: "SERVER_ERROR", message: "Failed to fetch posts." } });
      }
    }
  );

  // GET /api/blog/public/:slug — single published post (public)
  fastify.get<{ Params: { slug: string } }>(
    "/public/:slug",
    { onRequest: [] as any },
    async (request, reply) => {
      const { slug } = request.params;
      try {
        const res = await query(
          `SELECT id, slug, title, excerpt, body, cover_image_url, published_at, meta_title, meta_description,
                  author_admin_id
           FROM blog_posts WHERE slug = $1 AND status = 'published'`,
          [slug]
        );

        if (res.rows.length === 0) {
          return reply.status(404).send({ success: false, error: { code: "NOT_FOUND", message: "Post not found." } });
        }

        return { success: true, post: res.rows[0] };
      } catch (err) {
        return reply.status(500).send({ success: false, error: { code: "SERVER_ERROR", message: "Failed to fetch post." } });
      }
    }
  );

  // ==============================
  // ADMIN BLOG CRUD
  // ==============================

  // GET /api/admin/blog — list all posts (draft + published)
  fastify.get(
    "/",
    async (request, reply) => {
      try {
        const res = await query(
          `SELECT p.id, p.slug, p.title, p.excerpt, p.status, p.published_at, p.cover_image_url,
                  p.created_at, p.updated_at, a.name AS author_name
           FROM blog_posts p
           LEFT JOIN admins a ON p.author_admin_id = a.id
           ORDER BY p.created_at DESC`
        );
        return { success: true, posts: res.rows };
      } catch (err) {
        return reply.status(500).send({ success: false, error: { code: "SERVER_ERROR", message: "Failed to list posts." } });
      }
    }
  );

  // GET /api/admin/blog/:id — get single post by id
  fastify.get<{ Params: { id: string } }>(
    "/:id",
    async (request, reply) => {
      const { id } = request.params;
      try {
        const res = await query("SELECT * FROM blog_posts WHERE id = $1", [id]);
        if (res.rows.length === 0) {
          return reply.status(404).send({ success: false, error: { code: "NOT_FOUND", message: "Post not found." } });
        }
        return { success: true, post: res.rows[0] };
      } catch (err) {
        return reply.status(500).send({ success: false, error: { code: "SERVER_ERROR", message: "Failed to fetch post." } });
      }
    }
  );

  // POST /api/admin/blog — create a new post
  fastify.post<{
    Body: {
      title?: string;
      excerpt?: string;
      body?: string;
      cover_image_url?: string;
      status?: string;
      slug?: string;
      meta_title?: string;
      meta_description?: string;
    }
  }>(
    "/",
    async (request, reply) => {
      const { title, excerpt, body, cover_image_url, status, slug, meta_title, meta_description } = request.body;

      if (!title || !excerpt || !body) {
        return reply.status(400).send({
          success: false,
          error: { code: "MISSING_PARAMS", message: "title, excerpt, and body are required." }
        });
      }

      const postStatus = status === "published" ? "published" : "draft";
      const postSlug = slug ? slug.toLowerCase().replace(/\s+/g, "-") : generateSlug(title);
      const sanitisedBody = sanitiseMarkdown(body);
      const authorId = request.adminUser!.id;
      const clientIp = getClientIp(request);
      const userAgent = request.headers["user-agent"] || null;

      try {
        const res = await query(
          `INSERT INTO blog_posts (slug, title, excerpt, body, cover_image_url, status, published_at, author_admin_id, meta_title, meta_description)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
          [
            postSlug,
            title.trim(),
            excerpt.trim(),
            sanitisedBody,
            cover_image_url || null,
            postStatus,
            postStatus === "published" ? new Date() : null,
            authorId,
            meta_title?.trim() || null,
            meta_description?.trim() || null
          ]
        );

        await query(
          `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
           VALUES ($1, 'BLOG_POST_CREATED', $2, $3, $4)`,
          [authorId, `post:${postSlug}`, clientIp, userAgent]
        );

        return reply.status(201).send({ success: true, post: res.rows[0] });
      } catch (err: any) {
        if (err.code === "23505") {
          return reply.status(409).send({
            success: false,
            error: { code: "SLUG_EXISTS", message: "A post with this slug already exists. Choose a different title or slug." }
          });
        }
        return reply.status(500).send({ success: false, error: { code: "SERVER_ERROR", message: "Failed to create post." } });
      }
    }
  );

  // PUT /api/admin/blog/:id — update a post
  fastify.put<{
    Params: { id: string };
    Body: {
      title?: string;
      excerpt?: string;
      body?: string;
      cover_image_url?: string;
      status?: string;
      meta_title?: string;
      meta_description?: string;
    }
  }>(
    "/:id",
    async (request, reply) => {
      const { id } = request.params;
      const { title, excerpt, body, cover_image_url, status, meta_title, meta_description } = request.body;

      const clientIp = getClientIp(request);
      const userAgent = request.headers["user-agent"] || null;
      const actorId = request.adminUser!.id;

      try {
        const existingRes = await query("SELECT * FROM blog_posts WHERE id = $1", [id]);
        if (existingRes.rows.length === 0) {
          return reply.status(404).send({ success: false, error: { code: "NOT_FOUND", message: "Post not found." } });
        }

        const existing = existingRes.rows[0];

        const newStatus = status || existing.status;
        const publishedAt = newStatus === "published" && existing.status !== "published"
          ? new Date()
          : existing.published_at;

        const updatedBody = body ? sanitiseMarkdown(body) : existing.body;

        const res = await query(
          `UPDATE blog_posts SET
             title = COALESCE($1, title),
             excerpt = COALESCE($2, excerpt),
             body = $3,
             cover_image_url = COALESCE($4, cover_image_url),
             status = $5,
             published_at = $6,
             meta_title = COALESCE($7, meta_title),
             meta_description = COALESCE($8, meta_description),
             updated_at = CURRENT_TIMESTAMP
           WHERE id = $9 RETURNING *`,
          [
            title?.trim() || null,
            excerpt?.trim() || null,
            updatedBody,
            cover_image_url || null,
            newStatus,
            publishedAt,
            meta_title?.trim() || null,
            meta_description?.trim() || null,
            id
          ]
        );

        await query(
          `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
           VALUES ($1, 'BLOG_POST_UPDATED', $2, $3, $4)`,
          [actorId, `post:${id}`, clientIp, userAgent]
        );

        return { success: true, post: res.rows[0] };
      } catch (err) {
        return reply.status(500).send({ success: false, error: { code: "SERVER_ERROR", message: "Failed to update post." } });
      }
    }
  );

  // DELETE /api/admin/blog/:id — delete a post
  fastify.delete<{ Params: { id: string } }>(
    "/:id",
    { onRequest: [fastify.requireRole(["superadmin", "admin"])] },
    async (request, reply) => {
      const { id } = request.params;
      const clientIp = getClientIp(request);
      const userAgent = request.headers["user-agent"] || null;
      const actorId = request.adminUser!.id;

      try {
        const res = await query("DELETE FROM blog_posts WHERE id = $1 RETURNING slug", [id]);
        if (res.rowCount === 0) {
          return reply.status(404).send({ success: false, error: { code: "NOT_FOUND", message: "Post not found." } });
        }

        await query(
          `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
           VALUES ($1, 'BLOG_POST_DELETED', $2, $3, $4)`,
          [actorId, `post:${id}`, clientIp, userAgent]
        );

        return { success: true };
      } catch (err) {
        return reply.status(500).send({ success: false, error: { code: "SERVER_ERROR", message: "Failed to delete post." } });
      }
    }
  );

  // POST /api/admin/blog/upload-cover — Upload cover image to Cloudflare R2
  fastify.post(
    "/upload-cover",
    async (request, reply) => {
      const actorId = request.adminUser!.id;
      const clientIp = getClientIp(request);
      const userAgent = request.headers["user-agent"] || null;

      try {
        const data = await request.file();
        if (!data) {
          return reply.status(400).send({ success: false, error: { code: "NO_FILE", message: "No file uploaded." } });
        }

        const allowedMimeTypes = ["image/jpeg", "image/png", "image/webp"];
        if (!allowedMimeTypes.includes(data.mimetype)) {
          return reply.status(400).send({
            success: false,
            error: { code: "INVALID_TYPE", message: "Only JPEG, PNG, and WebP images are accepted." }
          });
        }

        const r2Endpoint = process.env.CLOUDFLARE_R2_ENDPOINT;
        const r2Bucket = process.env.CLOUDFLARE_R2_BUCKET_NAME || "dira-photos";
        const accessKey = process.env.CLOUDFLARE_R2_ACCESS_KEY_ID;
        const secretKey = process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY;

        if (!r2Endpoint || !accessKey || !secretKey) {
          return reply.status(503).send({
            success: false,
            error: { code: "R2_UNCONFIGURED", message: "Cloudflare R2 storage is not configured." }
          });
        }

        const fileBuffer = await data.toBuffer();
        const ext = data.mimetype.split("/")[1].replace("jpeg", "jpg");
        const filename = `blog-covers/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

        // Sign and upload using S3-compatible AWS Signature V4
        const crypto = await import("crypto");
        const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "").slice(0, 15) + "Z";
        const dateStamp = date.slice(0, 8);
        const service = "s3";
        const region = "auto";
        const host = r2Endpoint.replace("https://", "");

        const canonicalUri = `/${filename}`;
        const canonicalQueryString = "";
        const payloadHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");
        const canonicalHeaders = `content-type:${data.mimetype}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${date}\n`;
        const signedHeaders = "content-type;host;x-amz-content-sha256;x-amz-date";
        const canonicalRequest = `PUT\n${canonicalUri}\n${canonicalQueryString}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

        const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
        const stringToSign = `AWS4-HMAC-SHA256\n${date}\n${credentialScope}\n${crypto.createHash("sha256").update(canonicalRequest).digest("hex")}`;

        const hmac = (key: Buffer, data: string) => crypto.createHmac("sha256", key).update(data).digest();
        const signingKey = hmac(hmac(hmac(hmac(Buffer.from("AWS4" + secretKey), dateStamp), region), service), "aws4_request");
        const signature = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");

        const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

        const uploadResponse = await fetch(`https://${host}/${filename}`, {
          method: "PUT",
          headers: {
            "Content-Type": data.mimetype,
            "x-amz-content-sha256": payloadHash,
            "x-amz-date": date,
            "Authorization": authorizationHeader
          },
          body: new Uint8Array(fileBuffer)
        });

        if (!uploadResponse.ok) {
          const errText = await uploadResponse.text();
          fastify.log.error(`R2 upload failed: ${uploadResponse.status} ${errText}`);
          return reply.status(500).send({ success: false, error: { code: "UPLOAD_FAILED", message: "Failed to upload image to storage." } });
        }

        const publicUrl = `https://photos.diraafrica.org/${filename}`;

        await query(
          `INSERT INTO admin_audit_log (actor_admin_id, action, target, ip, user_agent)
           VALUES ($1, 'BLOG_COVER_UPLOADED', $2, $3, $4)`,
          [actorId, filename, clientIp, userAgent]
        );

        return { success: true, url: publicUrl };
      } catch (err: any) {
        fastify.log.error(err, "Cover upload error:");
        return reply.status(500).send({ success: false, error: { code: "SERVER_ERROR", message: "Failed to upload cover image." } });
      }
    }
  );
}
