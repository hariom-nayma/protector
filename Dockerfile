FROM ghcr.io/puppeteer/puppeteer:24.3.0

USER root

# Set working directory
WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
# Using --unsafe-perm because we are running as root initially to install, 
# then we switch back to pptruser (provided by the base image) if needed, 
# but the base image setup usually handles this.
# npm ci is faster and more reliable for builds.
RUN npm ci

# Copy the rest of the application code
COPY . .

# Create the chrome_profile directory and ensure permissions
RUN mkdir -p chrome_profile && chmod -R 777 chrome_profile

# Switch to non-root user (pptruser is created by the base image)
USER pptruser

# Environment variables
ENV HEADLESS=true
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/google-chrome-stable

# Command to run the bot
CMD ["npm", "start"]
