# syntax=docker/dockerfile:1

# Install production dependencies with npm in a throwaway stage.
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# Runtime: plain Alpine with just the Node.js binary (no npm/yarn), ~70 MB total.
FROM alpine:3.22
RUN apk add --no-cache nodejs \
    && adduser -D -H -u 1000 bot \
    && mkdir -p /data && chown bot:bot /data

ENV NODE_ENV=production \
    DATA_DIR=/data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

USER bot
VOLUME ["/data"]
CMD ["node", "src/index.js"]
