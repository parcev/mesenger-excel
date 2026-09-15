FROM node:20

# Set working directory inside container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json (if available)
COPY package*.json ./

# Install application dependencies
RUN npm install --production

# Install Playwright Chromium browser binaries along with required Linux OS libraries
RUN npx playwright install --with-deps chromium

# Copy remaining source code
COPY . .

# Expose server port
EXPOSE 3000

# Set environment to production
ENV NODE_ENV=production

# Start the Node.js application
CMD ["node", "index.js"]
