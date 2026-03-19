###################
# BUILD FOR LOCAL DEVELOPMENT
###################

FROM node:22-slim As development

# Install build tools for native modules (better-sqlite3 on ARM64)
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Create app directory
WORKDIR /usr/src/app

# Copy application dependency manifests to the container image.
# A wildcard is used to ensure copying both package.json AND package-lock.json (when available).
# Copying this first prevents re-running npm install on every code change.
COPY --chown=node:node package.json pnpm-lock.yaml ./

# Install pnpm
RUN npm install -g pnpm@9

# Install app dependencies using the `npm ci` command instead of `npm install`
RUN pnpm install --frozen-lockfile

# Bundle app source
COPY --chown=node:node . .

# Use the node user from the image (instead of the root user)
USER node

###################
# BUILD FOR PRODUCTION
###################

FROM node:22-slim As build

WORKDIR /usr/src/app

COPY --chown=node:node package.json pnpm-lock.yaml ./

# In order to run `npm run build` we need access to the Nest CLI which is a dev dependency. In the previous development stage we ran `npm ci` which installed all dependencies, so we can copy over the node_modules directory from the development image
COPY --chown=node:node --from=development /usr/src/app/node_modules ./node_modules

COPY --chown=node:node . .

# Install pnpm
RUN npm install -g pnpm

# Run the build command which creates the production bundle
RUN pnpm run build

# Set NODE_ENV environment variable
ENV NODE_ENV production

# Running `npm ci` removes the existing node_modules directory and passing in --only=production ensures that only the production dependencies are installed. This ensures that the node_modules directory is as optimized as possible
RUN CI=true pnpm prune --prod

USER node

###################
# PRODUCTION
###################

FROM node:22-slim As production

# Install openssl for key generation
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy the bundled code from the build stage to the production image
COPY --chown=node:node --from=build /usr/src/app/node_modules ./node_modules
COPY --chown=node:node --from=build /usr/src/app/dist ./dist

# Copy entrypoint script
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Create keys directory (will be overwritten by volume mount in K8s)
RUN mkdir -p /app/keys && chown node:node /app/keys

# Create data directory for SQLite (selfhosted mode)
RUN mkdir -p /app/data && chown node:node /app/data

# Environment variables with defaults
ENV NODE_ENV=production
ENV KEYS_DIR=/app/keys
ENV PRIVATE_KEY_PATH=/app/keys/private.pem
ENV PUBLIC_KEY_PATH=/app/keys/public.pem

# Use node user
USER node

# Health check for Docker and orchestration
HEALTHCHECK --interval=30s --timeout=5s --retries=3 --start-period=15s \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

# Use entrypoint script to generate keys if needed
ENTRYPOINT ["docker-entrypoint.sh"]

# Start the server using the production build
CMD ["node", "dist/main.js"]