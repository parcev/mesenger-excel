# Use official Microsoft Playwright image with Node.js 20 and pre-installed browser dependencies
FROM mcr.microsoft.com/playwright/node:20-jammy

# Set working directory inside container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install application dependencies
RUN npm install --production

# Install Playwright Chromium browser binaries
RUN npx playwright install chromium

# Copy remaining source code
COPY . .

# Expose server port
EXPOSE 3000

# Set environment to production
ENV NODE_ENV=production

# Start the Node.js application
CMD ["node", "index.js"]