FROM node:18-alpine

WORKDIR /app

# Copy root package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy entire project
COPY . .

# Expose port
EXPOSE 3000

# Start the frontend server
CMD ["node", "server.js"]
