/**
 * Vercel serverless entrypoint.
 *
 * Vercel has no long-lived process, so an Express server listening on a port
 * cannot be the production deployment. The same app is exported as a request
 * handler and Vercel invokes it per request. The routes are identical — this
 * file adds no behaviour.
 *
 * Required environment variable:
 *   FIREBASE_SERVICE_ACCOUNT — the service account JSON (raw or base64).
 *
 * There is no filesystem to read a key file from in a serverless deploy, which is
 * why credentials must come from the environment.
 */
import { createApp } from "../src/app.js";

export default createApp();
