FROM node:18-alpine

WORKDIR /app

# Copy root package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy entire project (including shared modules)
COPY . .

# Create logs directory
RUN mkdir -p /app/logs

# Expose port
EXPOSE 3001

# Start the auth service
CMD ["node", "services/auth-service/index.js"]
