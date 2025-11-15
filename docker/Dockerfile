# Use official n8n base and copy our custom entrypoint
FROM n8nio/n8n:1.120.2

# Copy the entrypoint script into the image
COPY entrypoint.js /usr/local/bin/entrypoint.js

# Ensure the entrypoint is executable
RUN chmod +x /usr/local/bin/entrypoint.js || true

USER root
RUN chown node:node /usr/local/bin/entrypoint.js || true

# Install the Postgres client library for Node so the entrypoint
# can perform DB fallback activation when REST activation fails.
# No DB client install required for import-only behavior
USER node

ENTRYPOINT ["node", "/usr/local/bin/entrypoint.js"]
