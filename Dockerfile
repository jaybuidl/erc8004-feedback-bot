# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY tsconfig.build.json ./
COPY src ./src
RUN npm run build

# Production stage
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist

# Create data directory for SQLite
RUN mkdir -p data logs && chown -R node:node /app

USER node

EXPOSE 3000

CMD ["node", "dist/src/index.js"]
