FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    bash \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | BINDIR=/usr/local/bin sh

ENV ARDUINO_DATA_DIR=/arduino/data
ENV ARDUINO_USER_DIR=/arduino/user

RUN mkdir -p /arduino/user/libraries && \
    arduino-cli core update-index && \
    arduino-cli core install arduino:avr && \
    arduino-cli lib update-index && \
    arduino-cli lib install "Adafruit NeoPixel" && \
    arduino-cli lib install "Stepper" && \
    arduino-cli lib install "Servo"

RUN chmod -R 755 /arduino

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

RUN mkdir -p temp data/components

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

RUN groupadd -r appgroup && useradd -r -g appgroup -m appuser && \
    chown -R appuser:appgroup /app && \
    chown -R appuser:appgroup /arduino
USER appuser

EXPOSE 5001

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -sf http://localhost:5001/health || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "src/server.js"]
