# Use an official Node runtime as the base image
FROM node:18-alpine

# Set working directory
WORKDIR /app

# Copy package files first and install dependencies
COPY package.json ./
RUN npm install --production

# Copy the rest of the application
COPY index.js ./
COPY knowledge ./knowledge

# Expose the default port
EXPOSE 3000

# Command to run the app
CMD ["node", "index.js"]