# Conclave backend container image.
#
# The app runs its TypeScript entrypoint directly via tsx (a production
# dependency) — the same as `npm start` — so there is no compile step. Node 20
# LTS matches package.json engines (>=20).
FROM node:20-slim

WORKDIR /app

# Install production dependencies first for better layer caching. tsx and
# firebase-admin are runtime deps; typescript (dev-only) is not needed at
# runtime because tsx strips types with esbuild.
COPY package*.json ./
RUN npm ci --omit=dev

# Application source.
COPY . .

ENV NODE_ENV=production
# Container Apps injects PORT; the app reads env.port (defaults to 3000).
ENV PORT=3000
EXPOSE 3000

CMD ["npm", "start"]
