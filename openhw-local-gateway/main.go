package main

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
	"github.com/containers/gvisor-tap-vsock/pkg/virtualnetwork"
	"github.com/google/gopacket"
	"github.com/google/gopacket/layers"
	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for the local gateway
	},
}

type Client struct {
	Conn       *websocket.Conn
	WriteMutex sync.Mutex
}

type Room struct {
	sync.Mutex
	SessionId string
	VN        *virtualnetwork.VirtualNetwork
	Clients   map[*Client]bool
	PipeToVN  net.Conn
	Ctx       context.Context
	Cancel    context.CancelFunc
	NextIP    byte
	MacToIP   map[string]net.IP
}

var (
	roomsMutex sync.Mutex
	rooms      = make(map[string]*Room)
)

const PORT = "5099"

func main() {
	fmt.Println("===================================================")
	fmt.Println("   OpenHW Studio - Private IoT Gateway (Go)")
	fmt.Println("===================================================")

	http.HandleFunc("/api/network-gateway", func(w http.ResponseWriter, r *http.Request) {
		sessionId := r.URL.Query().Get("sessionId")
		if sessionId == "" {
			b := make([]byte, 8)
			_, _ = rand.Read(b)
			sessionId = fmt.Sprintf("isolated-%x", b)
		}

		roomsMutex.Lock()
		room, exists := rooms[sessionId]
		if !exists {
			fmt.Printf("[Network Gateway] Creating new Virtual Network for room: %s\n", sessionId)
			gatewayMode := os.Getenv("GATEWAY_MODE")
			forwards := map[string]string{}
			if gatewayMode != "public" {
				fmt.Println("[Network Gateway] Private Mode: Port forwarding enabled (localhost:8080 -> 192.168.127.2:80)")
				forwards["127.0.0.1:8080"] = "192.168.127.2:80"
			}

			config := types.Configuration{
				Debug:             false,
				MTU:               1500,
				Subnet:            "192.168.127.0/24",
				GatewayIP:         "192.168.127.1",
				GatewayMacAddress: "5a:94:ef:e4:0c:dd",
				Forwards:          forwards,
			}

			vn, err := virtualnetwork.New(&config)
			if err != nil {
				roomsMutex.Unlock()
				fmt.Printf("Error creating virtual network: %v\n", err)
				return
			}

			pipe1, pipe2, err := connLoopback()
			if err != nil {
				roomsMutex.Unlock()
				fmt.Printf("Error creating pipe: %v\n", err)
				return
			}

			ctx, cancel := context.WithCancel(context.Background())

			room = &Room{
				SessionId: sessionId,
				VN:        vn,
				Clients:   make(map[*Client]bool),
				PipeToVN:  pipe2,
				Ctx:       ctx,
				Cancel:    cancel,
				NextIP:    2,
				MacToIP:   make(map[string]net.IP),
			}
			rooms[sessionId] = room

			// Start the single gVisor acceptor for this room
			go vn.AcceptQemu(ctx, pipe1)

			// Start the single reader that takes frames from gVisor and broadcasts to ALL clients
			go gvisorToClientsLoop(room)

		} else {
			fmt.Printf("[Network Gateway] Joining existing Virtual Network room: %s\n", sessionId)
		}
		roomsMutex.Unlock()

		fmt.Printf("\n--- INCOMING WEBSOCKET REQUEST ---\n")
		fmt.Printf("URL: %s\n", r.URL.String())

		wsConn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			fmt.Printf("WebSocket Upgrade Error: %v\n", err)
			return
		}

		fmt.Println("[Network Gateway] Client connected. Upgrade successful!")

		client := &Client{Conn: wsConn}
		room.Lock()
		room.Clients[client] = true
		room.Unlock()

		handleClient(client, room)
	})

	fmt.Printf("[Network Gateway] Standalone Server running on ws://localhost:%s/api/network-gateway\n", PORT)
	if err := http.ListenAndServe(":"+PORT, nil); err != nil {
		fmt.Printf("Server Error: %v\n", err)
	}
}

func connLoopback() (net.Conn, net.Conn, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, nil, err
	}
	port := listener.Addr().(*net.TCPAddr).Port
	conn, err := net.Dial("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil {
		return nil, nil, err
	}
	conn2, err := listener.Accept()
	listener.Close()
	return conn, conn2, err
}

// gvisorToClientsLoop reads Ethernet frames from gVisor and broadcasts them to all connected clients in the room.
func gvisorToClientsLoop(room *Room) {
	for {
		var length uint32
		err := binary.Read(room.PipeToVN, binary.BigEndian, &length)
		if err != nil {
			fmt.Printf("[Room %s] Pipe Read Error (size): %v\n", room.SessionId, err)
			return
		}

		buf := make([]byte, length)
		_, err = io.ReadFull(room.PipeToVN, buf)
		if err != nil {
			fmt.Printf("[Room %s] Pipe Read Error (data): %v\n", room.SessionId, err)
			return
		}

		if len(buf) >= 14 {
			dst := buf[0:6]
			src := buf[6:12]
			ethType := binary.BigEndian.Uint16(buf[12:14])
			fmt.Printf("[%s] [gVisor -> Hub] << Eth Frame (dst=%x, src=%x, type=0x%04x, len=%d)\n", time.Now().Format("15:04:05.000"), dst, src, ethType, length)
		}

		// Broadcast frame to all clients
		room.Lock()
		targets := make([]*Client, 0, len(room.Clients))
		for client := range room.Clients {
			targets = append(targets, client)
		}
		room.Unlock()

		for _, client := range targets {
			client.WriteMutex.Lock()
			err = client.Conn.WriteMessage(websocket.BinaryMessage, buf)
			client.WriteMutex.Unlock()
			if err != nil {
				fmt.Printf("[Room %s] Client Write Error: %v\n", room.SessionId, err)
			}
		}
	}
}

// handleClient reads Ethernet frames from a specific WebSocket client and multiplexes them.
func handleClient(client *Client, room *Room) {
	defer func() {
		client.Conn.Close()
		room.Lock()
		delete(room.Clients, client)
		isEmpty := len(room.Clients) == 0
		room.Unlock()
		fmt.Println("[Network Gateway] Client disconnected.")

		if isEmpty {
			fmt.Printf("[Room %s] Empty! Cleaning up virtual network...\n", room.SessionId)
			room.Cancel() // Stop vn.AcceptQemu
			if room.PipeToVN != nil {
				room.PipeToVN.Close() // Stop gvisorToClientsLoop
			}

			roomsMutex.Lock()
			delete(rooms, room.SessionId)
			roomsMutex.Unlock()
		}
	}()

	// Ping/Pong Timeout Setup
	pongWait := 60 * time.Second
	pingPeriod := 50 * time.Second

	client.Conn.SetReadDeadline(time.Now().Add(pongWait))
	client.Conn.SetPongHandler(func(string) error {
		client.Conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	clientCtx, clientCancel := context.WithCancel(context.Background())
	defer clientCancel()

	go func() {
		ticker := time.NewTicker(pingPeriod)
		defer ticker.Stop()
		for {
			select {
			case <-clientCtx.Done():
				return
			case <-room.Ctx.Done():
				return
			case <-ticker.C:
				client.WriteMutex.Lock()
				err := client.Conn.WriteMessage(websocket.PingMessage, nil)
				client.WriteMutex.Unlock()
				if err != nil {
					client.Conn.Close()
					return
				}
			}
		}
	}()

	for {
		messageType, msg, err := client.Conn.ReadMessage()
		if err != nil {
			fmt.Printf("WebSocket Read Error: %v\n", err)
			return
		}

		if messageType == websocket.BinaryMessage {
			if len(msg) >= 14 {
				dst := msg[0:6]
				src := msg[6:12]
				ethType := binary.BigEndian.Uint16(msg[12:14])
				fmt.Printf("[%s] [ESP32 -> Hub] >> Eth Frame (dst=%x, src=%x, type=0x%04x, len=%d)\n", time.Now().Format("15:04:05.000"), dst, src, ethType, len(msg))
			}

			// Intercept DHCP Packets
			packet := gopacket.NewPacket(msg, layers.LayerTypeEthernet, gopacket.Default)
			if udpLayer := packet.Layer(layers.LayerTypeUDP); udpLayer != nil {
				udp, _ := udpLayer.(*layers.UDP)
				if udp.DstPort == 67 {
					handleDHCP(msg, packet, client, room)
					continue // DO NOT forward to gVisor or other clients!
				}
			}

			// 1. Send frame to gVisor stack
			room.Lock()
			pipe := room.PipeToVN
			room.Unlock()
			
			if pipe != nil {
				err = binary.Write(pipe, binary.BigEndian, uint32(len(msg)))
				if err == nil {
					_, err = pipe.Write(msg)
				}
			}
			
			// 2. Broadcast frame to all *other* clients (Layer 2 Hub logic)
			room.Lock()
			targets := make([]*Client, 0, len(room.Clients))
			for otherClient := range room.Clients {
				if otherClient != client {
					targets = append(targets, otherClient)
				}
			}
			room.Unlock()

			for _, otherClient := range targets {
				otherClient.WriteMutex.Lock()
				otherClient.Conn.WriteMessage(websocket.BinaryMessage, msg)
				otherClient.WriteMutex.Unlock()
			}

			if err != nil {
				fmt.Printf("[Room %s] Pipe Write Error: %v\n", room.SessionId, err)
				return
			}
		}
	}
}
