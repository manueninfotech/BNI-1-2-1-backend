import type { NextFunction, Request, Response } from "express";
import { audit } from "../audit/audit.service.js";
import { ANONYMOUS, newRequestId, runWithContext, type Source } from "../observability/context.js";

/**
 * First middleware on every request.
 *
 * - Assigns a request id (honours a sane incoming X-Request-Id, else a UUID) and
 *   echoes it back, so a support report can be traced through logs and audit.
 * - Works out which client is calling (X-Client header, else heuristics).
 * - After the response is sent, writes the "request" audit row for every
 *   state-changing call and every denied one — whoever made it, wherever from.
 */

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const SAFE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

function detectSource(req: Request): Source {
  const client = String(req.headers["x-client"] ?? "").toLowerCase();
  if (client.startsWith("mobile")) return "mobile_app";
  if (client.startsWith("admin")) return "admin_panel";
  if (req.path.startsWith("/api/webhooks")) return "webhook";
  const ua = String(req.headers["user-agent"] ?? "");
  if (/^Dart\/|okhttp|CFNetwork/i.test(ua)) return "mobile_app";
  if (req.path.startsWith("/api/admin") || /Mozilla\//.test(ua)) return "admin_panel";
  return "unknown";
}

export function requestContext(req: Request, res: Response, next: NextFunction) {
  const incoming = String(req.headers["x-request-id"] ?? "");
  const requestId = SAFE_ID.test(incoming) ? incoming : newRequestId();
  res.setHeader("X-Request-Id", requestId);

  const source = detectSource(req);
  const ctx = {
    requestId,
    source,
    actor: source === "webhook" ? { uid: null, role: "webhook", name: "razorpay" } : ANONYMOUS,
    ip: req.ip ?? null,
    userAgent: String(req.headers["user-agent"] ?? "").slice(0, 300) || null,
    changeCount: 0,
  };

  const started = process.hrtime.bigint();
  res.on("finish", () => {
    const status = res.statusCode;
    const denied = status === 401 || status === 403;
    if (!MUTATING.has(req.method) && !denied) return;
    // Route PATTERN (/api/admin/conclaves/:id), not the raw URL, so rows group.
    const route = `${req.baseUrl ?? ""}${(req as any).route?.path ?? ""}` || req.path;
    const params = (req.params ?? {}) as Record<string, string>;
    runWithContext(ctx, () =>
      audit.request({
        method: req.method,
        route,
        statusCode: status,
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
        entityId: params.id ?? params.uid ?? null,
        conclaveId: route.includes("/conclaves/:id") ? params.id ?? null : params.conclaveId ?? null,
        body: req.body,
        query: req.query,
        error: (res.locals.errorMessage as string | undefined) ?? null,
      }),
    );
  });

  runWithContext(ctx, () => next());
}
