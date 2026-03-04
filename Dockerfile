# Use Node.js as the base image
FROM node:20

# Install dependencies for arduino-cli
RUN apt-get update && apt-get install -y \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install arduino-cli
RUN curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh
ENV PATH=$PATH:/root/bin

# Initialize arduino-cli and install AVR core
# We need to update the index first
RUN arduino-cli core update-index
RUN arduino-cli core install arduino:avr

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code
COPY . .

# Ensure temp directory exists for compilation
RUN mkdir -p temp

# Expose the port
EXPOSE 5000

# Set environment variables (these should also be set in Render dashboard)
ENV PORT=5000

# Start the application
CMD ["npm", "start"]
