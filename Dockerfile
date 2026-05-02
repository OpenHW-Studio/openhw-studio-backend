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
    arduino-cli core install rp2040:rp2040 && \
    rm -rf /root/.arduino15/staging/*

# Install Raspberry Pi Pico SDK
ENV PICO_SDK_PATH=/opt/pico-sdk
RUN git clone -b master https://github.com/raspberrypi/pico-sdk.git $PICO_SDK_PATH && \
    cd $PICO_SDK_PATH && \
    git submodule update --init

# Pre-install common libraries for the simulator (Pico/AVR compatible)
RUN arduino-cli lib install \
    "Adafruit NeoPixel" \
    "Stepper" \
    "Servo" \
    "Adafruit GFX Library" \
    "Adafruit SSD1306" \
    "Adafruit ILI9341" \
    "LiquidCrystal I2C" \
    "PubSubClient" \
    "ArduinoJson" \
    "Adafruit MPU6050" \
    "Adafruit BusIO" \
    "Adafruit Unified Sensor" \
    "Ticker" \
    && rm -rf /root/.arduino15/staging/*

RUN chmod -R 755 /arduino

WORKDIR /app

COPY openhw-studio-backend/package*.json ./

# Install dependencies
RUN npm install

# Copy the application code and required sibling repos from the build context
COPY openhw-studio-backend/ .
COPY openhw-studio-examples/ ./openhw-studio-examples/
COPY openhw-studio-emulator/ ./openhw-studio-emulator/

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
