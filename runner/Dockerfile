# Dockerfile for the AI runner service
#
# This Dockerfile builds and runs the asynchronous job runner contained in
# this repository. It relies on Node.js 20, installs only production
# dependencies and exposes a port for the server. The `npm start` script
# defined in package.json will launch the Express server.

FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install dependencies. We copy both package.json and package-lock.json
# when available. If there is no lockfile, npm will still succeed.
COPY package*.json ./
RUN if [ -f package-lock.json ]; then \
      npm ci --omit=dev; \
    else \
      npm install --omit=dev; \
    fi

# Copy the rest of the application
COPY . .

# Expose the port that the server will listen on (informational)
EXPOSE 8080

# Start the server. The start script is defined in package.json.
CMD [ "npm", "start" ]