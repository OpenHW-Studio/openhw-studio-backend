# Use Node.js as the base image
FROM node:20

# Install dependencies for arduino-cli and Docker CLI
RUN apt-get update && apt-get install -y \
    curl \
    python3 \
    python3-pip \
    python3-venv \
    wget \
    xz-utils \
    git \
    make \
    cmake \
    gcc-arm-none-eabi \
    libnewlib-arm-none-eabi \
    build-essential \
    ca-certificates \
    gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && chmod a+r /etc/apt/keyrings/docker.asc \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | tee /etc/apt/sources.list.d/docker.list > /dev/null \
    && apt-get update \
    && apt-get install -y docker-ce-cli docker-compose-plugin \
    && pip3 install --break-system-packages esptool \
    && rm -rf /var/lib/apt/lists/*

# Install Espressif QEMU for ESP32 simulation
RUN mkdir -p /opt/qemu && \
    wget -qO- https://github.com/espressif/qemu/releases/download/esp-develop-9.2.2-20260417/qemu-xtensa-softmmu-esp_develop_9.2.2_20260417-x86_64-linux-gnu.tar.xz | tar xJ -C /opt/qemu --strip-components=1
ENV QEMU_ESP32_PATH=/opt/qemu/bin/qemu-system-xtensa

# Install arduino-cli
RUN curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh | sh
ENV PATH=$PATH:/root/bin

# Initialize arduino-cli and install cores
RUN arduino-cli config init && \
    arduino-cli config set board_manager.additional_urls https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json && \
    arduino-cli config add board_manager.additional_urls https://espressif.github.io/arduino-esp32/package_esp32_index.json && \
    arduino-cli core update-index && \
    arduino-cli core install arduino:avr && \
    arduino-cli core install rp2040:rp2040 && \
    arduino-cli core install esp32:esp32 && \
    rm -rf /root/.arduino15/staging/*

# Install Raspberry Pi Pico SDK
ENV PICO_SDK_PATH=/opt/pico-sdk
RUN git clone --depth 1 -b master https://github.com/raspberrypi/pico-sdk.git $PICO_SDK_PATH && \
    cd $PICO_SDK_PATH && \
    git submodule update --init --depth 1

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

# Set working directory
WORKDIR /app

COPY openhw-studio-backend/package*.json ./

# Install dependencies
RUN npm install

# Copy the application code and required sibling repos from the build context
COPY openhw-studio-backend/ .
COPY openhw-studio-examples/ ./openhw-studio-examples/
COPY openhw-studio-emulator/ ./openhw-studio-emulator/

# Ensure temp and data directories exist
RUN mkdir -p temp
RUN mkdir -p data/components

# Expose the port
EXPOSE 5000

# Set environment variables (these should also be set in Render dashboard)
ENV PORT=5000

# Start the application
CMD ["npm", "start"]
