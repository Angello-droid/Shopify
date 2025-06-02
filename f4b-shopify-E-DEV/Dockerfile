
# Install dependencies only when needed
FROM node:18-alpine AS deps
# Check https://github.com/nodejs/docker-node/tree/b4117f9333da4138b03a546ec926ef50a31506c3#nodealpine to understand why libc6-compat might be needed.
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

# Rebuild the source code only when needed
FROM node:18-alpine AS builder
WORKDIR /app
COPY . .
COPY --from=deps /app/node_modules ./node_modules
RUN yarn build:ui

# Production image, copy all the files and start server
FROM node:18-alpine AS runner

RUN apk add dumb-init

WORKDIR /app


ENV NODE_ENV=$NODE_ENV

# Create the user and group for ownership 
RUN addgroup -g 1001 -S nodejs
RUN adduser -S runuser -u 1001

COPY --from=builder /app/server ./server
COPY --from=builder /app/ui/public ./ui/public
COPY --from=builder /app/ui/pages ./ui/pages
COPY --from=builder --chown=runuser:nodejs /app/ui/.next ./ui/.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/config.js ./config.js
COPY --from=builder /app/logger.js ./logger.js
COPY --from=builder /app/package.json ./package.json

# USER runuser

EXPOSE 80 3000

ENV PORT=$PORT
ENV NEXT_TELEMETRY_DISABLED 1

CMD ["dumb-init", "node", "server/index.js"]
