FROM node:18-alpine

WORKDIR /app

# Copy root package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy entire project (including shared modules)
COPY . .

# Expose port
EXPOSE 3002

# Start the order service
CMD ["node", "services/order-service/index.js"]
