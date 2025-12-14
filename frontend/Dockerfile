FROM node:24-alpine

# This declares a build-time argument that we can pass from docker-compose.
ARG BACKEND_URL

# Make this argument available as an environment variable for the 'npm run build' command.
ENV BACKEND_URL=$BACKEND_URL

WORKDIR /app

# Install dependencies
COPY package.json package-lock.json* ./
RUN npm ci

# Copy source code new
COPY . .

# Build the app
RUN npm run build

# Expose port
EXPOSE 3000

# Start the app
CMD ["npm", "start"]