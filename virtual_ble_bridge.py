import asyncio
import sys
import logging

try:
    from bumble.controller import Controller
    from bumble.link import LocalLink
    from bumble.transport import open_transport
    from bumble import hci
except ImportError:
    print("ERROR: bumble not installed. Run: pip install bumble")
    sys.exit(1)

logging.basicConfig(level=logging.WARNING)

async def main():
    print("===================================================")
    print("   OpenHW Studio - Virtual BLE Bridge (Windows)")
    print("===================================================")

    # 1. Create a shared virtual "air" link
    link = LocalLink()

    # 2. Create a Virtual Controller for the ESP32 emulator (Port 9544)
    print("[*] Starting TCP server on port 9544 for ESP32 Simulator...")
    emu_transport = await open_transport("tcp-server:_:9544")
    emu_controller = Controller(
        "emu-controller",
        host_source=emu_transport.source,
        host_sink=emu_transport.sink,
        link=link,
        public_address="00:11:22:33:44:55",
    )
    emu_controller.random_address = hci.Address(
        "00:11:22:33:44:55", hci.Address.PUBLIC_DEVICE_ADDRESS
    )

    # 3. Create a Virtual Controller for Bumble Console (Port 9545)
    print("[*] Starting TCP server on port 9545 for Bumble Console...")
    console_transport = await open_transport("tcp-server:_:9545")
    console_controller = Controller(
        "console-controller",
        host_source=console_transport.source,
        host_sink=console_transport.sink,
        link=link,
        public_address="AA:BB:CC:DD:EE:FF",
    )
    console_controller.random_address = hci.Address(
        "AA:BB:CC:DD:EE:FF", hci.Address.PUBLIC_DEVICE_ADDRESS
    )

    print("[+] Bridge is running! Both controllers are on the same virtual air link.")
    print("\nNext steps:")
    print("  1. Run the ESP32 Simulator (it connects to 9544 automatically via Go Gateway)")
    print("  2. Open a new terminal and run: bumble-console tcp-client:127.0.0.1:9545")
    print("  3. Type 'advertise' in the bumble console to broadcast to the ESP32!")
    print("\nPress Ctrl+C to stop.")

    try:
        await asyncio.get_running_loop().create_future()
    except asyncio.CancelledError:
        pass

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[*] Bridge stopped")
