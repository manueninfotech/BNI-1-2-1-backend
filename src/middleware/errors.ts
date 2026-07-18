import type { NextFunction, Request, Response } from "express";
import { isProduction } from "../config/env.js";

/**
 * An error with an HTTP status, thrown from anywhere and turned into a response
 * by the handler below.
 *
 * The point is that services can just `throw new ApiError(409, "...")` instead of
 * every controller re-implementing try/catch and status juggling.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** Extra fields merged into the JSON body — e.g. `conflictsWith`. */
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }

  static badRequest(msg: string, details?: Record<string, unknown>) {
    return new ApiError(400, msg, details);
  }
  static unauthorized(msg = "Sign in to continue.") {
    return new ApiError(401, msg);
  }
  static forbidden(msg: string) {
    return new ApiError(403, msg);
  }
  static notFound(msg: string) {
    return new ApiError(404, msg);
  }
  static conflict(msg: string, details?: Record<string, unknown>) {
    return new ApiError(409, msg, details);
  }
}

/**
 * Wraps an async handler so a rejected promise reaches the error middleware.
 *
 * Without this, an async controller that throws leaves the request hanging until
 * it times out — Express 4 does not catch rejections. (Express 5 does, but being
 * explicit costs nothing and survives a downgrade.)
 */
// The `any` is confined to this one boundary. Controllers below it are strongly
// typed against AuthedRequest; Express's own Request type simply cannot express
// "this handler runs after auth middleware, so `uid` is present".
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function asyncHandler(
  fn: (req: any, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

export function notFoundHandler(req: Request, res: Response) {
  res.status(404).json({ error: `No route for ${req.method} ${req.path}` });
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message, ...(err.details ?? {}) });
  }

  console.error("Unhandled error:", err);

  // Don't leak internals to clients in production.
  const message =
    !isProduction && err instanceof Error ? err.message : "Internal server error.";
  res.status(500).json({ error: message });
}
