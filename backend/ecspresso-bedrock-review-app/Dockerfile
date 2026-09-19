# Multi-stage build for smaller image size
#FROM node:18-alpine AS builder
FROM public.ecr.aws/docker/library/node:lts-alpine3.23 AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --omit=dev

# Production stage
FROM public.ecr.aws/docker/library/node:lts-alpine3.23

# Install dumb-init for proper signal handling
RUN apk add --no-cache dumb-init

# Create app directory
WORKDIR /app

# Copy dependencies from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application code
COPY package*.json ./
COPY src ./src

# Remove npm/npx (and the base image's own bundled copies of glob/minimatch/
# brace-expansion pulled in for npm's internal use) -- the running container
# only ever executes `node src/index.js`, so shipping the package manager at
# runtime is unnecessary attack surface. This also keeps CVEs in npm's own
# vendored dependencies (irrelevant to this app's dependency tree, see
# `npm ls brace-expansion --omit=dev`) out of the image Trivy scans.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 && \
    chown -R nodejs:nodejs /app

# Switch to non-root user
USER nodejs

# Expose port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD node -e "require('http').get('http://localhost:8080/health', (r) => {process.exit(r.statusCode === 200 ? 0 : 1)})"

# Use dumb-init to handle signals properly
ENTRYPOINT ["dumb-init", "--"]

# Start the application
CMD ["node", "src/index.js"]
