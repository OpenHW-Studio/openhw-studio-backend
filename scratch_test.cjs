const { spawn } = require('child_process');
const net = require('net');

console.log("Spawning Renode...");
const renode = spawn('renode', ['--plain', '--disable-xwt'], {
    stdio: ['ignore', 'pipe', 'pipe']
});

renode.stdout.on('data', (d) => {
    console.log("[Renode stdout]", d.toString().trim());
});

renode.stderr.on('data', (d) => {
    console.log("[Renode stderr]", d.toString().trim());
});

// Wait for Renode to start the telnet monitor
setTimeout(() => {
    console.log("Connecting to Renode Monitor via Telnet on port 1234...");
    const socket = net.connect(1234, '127.0.0.1');

    let output = '';
    socket.on('data', (chunk) => {
        const text = chunk.toString();
        output += text;
        console.log("[Monitor Output]", text);
    });

    socket.on('connect', () => {
        console.log("Connected! Initializing machine...");

        socket.write('mach create "stm32-test"\n');
        setTimeout(() => {
            socket.write('machine LoadPlatformDescription @platforms/cpus/stm32f103.repl\n');

            setTimeout(() => {
                console.log("Creating Socket Terminal on port 4050...");
                socket.write('emulation CreateServerSocketTerminal 4050 "term" false\n');

                setTimeout(() => {
                    console.log("Connecting usart1 to socket terminal...");
                    socket.write('connector Connect sysbus.usart1 term\n');

                    setTimeout(() => {
                        console.log("Closing connection and killing Renode...");
                        socket.destroy();
                        renode.kill();
                        process.exit(0);
                    }, 3000);
                }, 3000);
            }, 3000);
        }, 1000);
    });

    socket.on('error', (err) => {
        console.error("Socket error:", err.message);
        renode.kill();
        process.exit(1);
    });

}, 3000);
